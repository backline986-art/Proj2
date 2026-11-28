// WHAT A PARSE DID NOT SETTLE, KEPT WITH THE PROJECT.
//
// Every intake door ends a parse knowing things a person needs: which values it read but could
// not vouch for, which plan-set pages nobody read (over the image-page cap, over the text bound,
// text drawn as outlines), which documents disagreed. The Parser page showed these and dropped
// them at Save; the unattended doors (email, bulk drop) wrote the withheld field names to the
// audit log only. So every saved project read "parser completed without explicit review flags".
//
// This module is the one shape for that record (shared ParseReviewRecord, snapshot key
// `parseReview`), its validator (the Parser page posts it, so it is never trusted), the summary
// counts normalize.ts prints, and the single advisory review-queue item the unattended doors raise.
//
// RULE 2: an account / meter field's reading is never copied here, and the job's own account and
// meter digits are scrubbed from every line. The record is an object, so it is not a fill value
// and never reaches the planner prompt (resolveRecipeFieldValues skips object values).
import crypto from "node:crypto";
import type { ParseReviewRecord, ParseReviewValue, ParserExtractionResponse, ParserPayload } from "../../shared/src/types";
import { redactSecretValues } from "../../shared/src/portalSafety";
import type { AppDb } from "./db";
import { isPlannerSecretKey } from "./projectSecrets";
import { nowIso } from "./time";

export const PARSE_REVIEW_KEY = "parseReview";
/** The advisory review-queue item an unattended parse raises (never a gate: repository.ts
 *  ADVISORY_REVIEW_ISSUE_TYPES, dashboard.js the same list). */
export const PARSE_REVIEW_ISSUE_TYPE = "Parser read needs a look";
export const PARSE_REVIEW_FIELD = "parse_review";

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
/** Field ids whose READING is a secret (rule 2): the planner's own predicate, so the two cannot differ. */
const SECRET_FIELD = { test: (field: string) => isPlannerSecretKey(field) };
const MAX = { flags: 60, flagChars: 600, values: 120, text: 300, value: 200, conflicts: 60, readings: 6, pages: 400 } as const;

const str = (v: unknown, cap: number): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : v && typeof v === "object" ? JSON.stringify(v) : "").replace(/\s+/g, " ").trim().slice(0, cap);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The job's own account / meter readings, as a scrubber: the shared redactor (the one the planner's
 *  fields go through) replaces them wherever they stand in a line, separators ignored. */
function scrubberFor(secrets: readonly unknown[]): (text: string) => string {
  const list = secrets.map((v) => String(v ?? "").trim()).filter(Boolean);
  return (text) => (list.length ? redactSecretValues(text, list, () => "[withheld]") : text);
}

function secretsOf(payload: ParserPayload | null | undefined): unknown[] {
  const p = payload ?? {};
  return [p.account, p.meter, p.ubAccountNumber, p.ubMeterNumber, p.accountNumber, p.meterNumber];
}

/** Validate and bound a posted record. Returns null when there is nothing in it. */
export function sanitizeParseReview(raw: unknown, payload?: ParserPayload | null): ParseReviewRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // The secrets to scrub: the job's own account / meter, AND the reading of any secret field the
  // record itself lists (a withheld account number is not in the payload, but a reason beside it
  // may quote it).
  const listed = [...arr(r.uncertain), ...arr(r.conflicts).flatMap((c) => arr(obj(c).readings).map((x) => ({ field: obj(c).field, value: obj(x).value })))]
    .map(obj).filter((e) => SECRET_FIELD.test(str(e.field, 61))).map((e) => e.value);
  const scrub = scrubberFor([...secretsOf(payload), ...listed]);
  const line = (v: unknown, cap: number) => scrub(str(v, cap));
  // PROSE ABOUT A SECRET FIELD ("a smudged digit: … or …") can quote a reading that is neither the
  // job's value nor the one listed, so no value-keyed scrub can find it: every digit run in a
  // secret field's own reason / note goes.
  const secretProse = (v: unknown, cap: number) => line(v, cap).replace(/\d[\d\s\-.]{2,}\d/g, "[withheld]");
  const pagesOf = (v: unknown) => [...new Set(arr(v).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100_000))].sort((a, b) => a - b).slice(0, MAX.pages);
  const flags = [...new Set(arr(r.flags).map((f) => line(f, MAX.flagChars)).filter(Boolean))].slice(0, MAX.flags);
  const uncertain: ParseReviewValue[] = [];
  for (const entry of arr(r.uncertain).slice(0, MAX.values)) {
    const e = obj(entry);
    const field = str(e.field, 61);
    if (!FIELD_ID.test(field)) continue;
    const secret = SECRET_FIELD.test(field);
    uncertain.push({
      field,
      value: secret ? "" : line(e.value, MAX.value),
      kind: str(e.kind, 24).toLowerCase().replace(/[^a-z_]/g, "") || "unsure",
      reason: secret ? secretProse(e.reason, MAX.text) : line(e.reason, MAX.text),
      sheet: line(e.sheet, 60),
      excerpt: secret ? "" : line(e.excerpt, MAX.value),
      saved: e.saved === true,
    });
  }
  const missing = arr(r.missing).slice(0, MAX.values).map(obj)
    .map((m) => ({ field: str(m.field, 61), why: line(m.why, MAX.text) }))
    .filter((m) => FIELD_ID.test(m.field));
  const conflicts = arr(r.conflicts).slice(0, MAX.conflicts).map(obj)
    .map((c) => {
      const field = str(c.field, 61);
      const secret = SECRET_FIELD.test(field);
      return {
        field,
        readings: arr(c.readings).slice(0, MAX.readings).map(obj).map((x) => ({ value: secret ? "" : line(x.value, MAX.value), source: str(x.source, 40), sheet: line(x.sheet, 60) })),
        note: secret ? secretProse(c.note, MAX.text) : line(c.note, MAX.text),
      };
    })
    .filter((c) => FIELD_ID.test(c.field));
  const seenPages = new Set<number>();
  const pagesNotRead = arr(r.pagesNotRead).map(obj)
    .map((p) => ({ page: Number(p.page), reason: line(p.reason, 200) }))
    .filter((p) => Number.isInteger(p.page) && p.page > 0 && p.page < 100_000 && !seenPages.has(p.page) && Boolean(seenPages.add(p.page)))
    .sort((a, b) => a.page - b.page)
    .slice(0, MAX.pages);
  const record: ParseReviewRecord = {
    door: str(r.door, 40).toLowerCase().replace(/[^a-z_]/g, "") || "unknown",
    recordedAt: /^\d{4}-\d{2}-\d{2}T/.test(str(r.recordedAt, 40)) ? str(r.recordedAt, 40) : nowIso(),
    flags,
    uncertain,
    missing,
    conflicts,
    visionPages: pagesOf(r.visionPages),
    visionFields: [...new Set(arr(r.visionFields).map((f) => str(f, 61)).filter((f) => FIELD_ID.test(f)))].slice(0, MAX.values),
    pagesNotRead,
  };
  return parseReviewIsEmpty(record) ? null : record;
}

function parseReviewIsEmpty(r: ParseReviewRecord): boolean {
  return !r.flags.length && !r.uncertain.length && !r.missing.length && !r.conflicts.length && !r.visionPages.length && !r.pagesNotRead.length;
}

/** The counts normalize.ts prints in the project's parser summary. Nothing here ever reads as
 *  "clean": an empty list means the record holds none of that kind. */
export function parseReviewSummaryLines(review: ParseReviewRecord | null | undefined): string[] {
  if (!review) return [];
  const lines: string[] = [];
  const withheld = review.uncertain.filter((u) => !u.saved).length;
  const kept = review.uncertain.length - withheld;
  if (withheld) lines.push(`${withheld} value(s) read but withheld for a person to confirm`);
  if (kept) lines.push(`${kept} saved value(s) the read could not confirm`);
  if (review.conflicts.length) lines.push(`${review.conflicts.length} conflict(s) between readings`);
  if (review.pagesNotRead.length) lines.push(`${review.pagesNotRead.length} plan-set page(s) not read`);
  if (review.missing.length) lines.push(`${review.missing.length} field(s) no document states`);
  return lines;
}

/** One withheld or unconfirmed value an unattended parse hands to the record. */
export interface UncertainRead { field: string; value: unknown; kind: string; reason: string; sheet?: string; excerpt?: string; saved: boolean }

/** The record an UNATTENDED parse (email intake, bulk drop) leaves: built from the extraction the
 *  shared reader returned, through the same validator the Parser page's posted record takes. */
export function parseReviewFromExtraction(
  door: string,
  extraction: Pick<ParserExtractionResponse, "notes" | "conflicts" | "visionPages" | "visionFields" | "visionSkipped" | "outlinedTextPages" | "planTextPagesNotRead" | "imagePagesReadFailed"> | null | undefined,
  uncertain: readonly UncertainRead[],
  payload?: ParserPayload | null,
): ParseReviewRecord | null {
  if (!extraction) return null;
  const pagesNotRead = [
    ...(extraction.visionSkipped ?? []).map((s) => ({ page: s.page, reason: s.reason })),
    ...(extraction.outlinedTextPages ?? []).map((page) => ({ page, reason: "text drawn as outlines; a person reads this page" })),
    ...(extraction.planTextPagesNotRead ?? []).map((page) => ({ page, reason: "over the text read's length bound; not read" })),
  ];
  // The model's notes are a review line only when the parse left something open: on a clean read
  // they are commentary, and a record that exists only to hold commentary would read as a problem.
  const open = uncertain.length || pagesNotRead.length || (extraction.conflicts ?? []).length || extraction.imagePagesReadFailed;
  return sanitizeParseReview({
    door,
    recordedAt: nowIso(),
    flags: open && extraction.notes ? [extraction.notes] : [],
    uncertain,
    conflicts: (extraction.conflicts ?? []).map((c) => ({ field: c.field, readings: c.readings, note: c.note })),
    visionPages: extraction.visionPages ?? [],
    visionFields: extraction.visionFields ?? [],
    pagesNotRead,
  }, payload);
}

const listPages = (pages: number[]): string => {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(j > i ? `${pages[i]}-${pages[j]}` : String(pages[i]));
    i = j;
  }
  return out.join(", ");
};

/** The one sentence set a person reads in the review queue. "" when nothing needs a look. */
export function parseReviewNotice(review: ParseReviewRecord | null | undefined): string {
  if (!review) return "";
  const parts: string[] = [];
  const withheld = review.uncertain.filter((u) => !u.saved);
  if (withheld.length) {
    parts.push(`Read but NOT saved (${withheld.length}) — check each against the documents and enter the right value: ${withheld.slice(0, 20).map((u) => `${u.field}${u.value ? ` = ${u.value}` : " (value not shown here)"} [${u.kind}${u.sheet ? `, ${u.sheet}` : ""}${u.reason ? `: ${u.reason}` : ""}]`).join("; ")}${withheld.length > 20 ? `; and ${withheld.length - 20} more` : ""}.`);
  }
  if (review.conflicts.length) parts.push(`The documents disagree on: ${review.conflicts.slice(0, 12).map((c) => c.field).join(", ")}.`);
  if (review.pagesNotRead.length) {
    const byReason = new Map<string, number[]>();
    for (const p of review.pagesNotRead) byReason.set(p.reason, [...(byReason.get(p.reason) ?? []), p.page]);
    parts.push(`Plan-set pages nobody read: ${[...byReason.entries()].slice(0, 6).map(([reason, pages]) => `${listPages(pages)} (${reason})`).join("; ")}.`);
  }
  return parts.join(" ").slice(0, 3000);
}

/**
 * Raise (or refresh) the project's ONE advisory review item for an unattended parse. One item, not
 * one per field: QC keys its own items by field name (ensureReviewItem dedupes on it), so a
 * per-field row here would stand in the way of a QC blocker on the same field. Advisory: it never
 * holds a gate, and a person dismisses it once the values are checked. Returns whether one is open.
 */
export function raiseParseReviewItem(db: AppDb, projectId: string, review: ParseReviewRecord | null | undefined): boolean {
  const notes = parseReviewNotice(review);
  if (!notes) return false;
  const ts = nowIso();
  const existing = db.get<{ id: string }>("SELECT id FROM human_review_items WHERE project_id = ? AND field_name = ? LIMIT 1", [projectId, PARSE_REVIEW_FIELD]);
  if (existing) {
    db.run("UPDATE human_review_items SET status = 'pending', issue_type = ?, notes = ?, updated_at = ? WHERE id = ?", [PARSE_REVIEW_ISSUE_TYPE, notes, ts, existing.id]);
    return true;
  }
  db.run(
    `INSERT INTO human_review_items
       (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '', '', 'pending', ?, ?, ?)`,
    [crypto.randomUUID(), projectId, PARSE_REVIEW_ISSUE_TYPE, PARSE_REVIEW_FIELD, notes, ts, ts],
  );
  return true;
}
