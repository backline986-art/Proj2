// WHAT INTAKE READ FOR EACH FIELD, AND WHO CHANGED IT AFTER (extracted_fields, migration v92).
//
// The plan-check back-test (2026-11-23) could not answer two questions the review gates depend on:
// which fields intake got wrong, and who fixed them. extracted_fields held intake's read for only
// the 27 aliased fields, and every later save re-wrote ALL of them as `human_verified` with no name,
// so a field nobody touched read as checked by a person and a real fix could not be told apart.
//
// Now:
//   • at creation, one row per field intake read (every short scalar in the snapshot, not only the
//     aliased ones), source_method "intake" — the baseline;
//   • on every later save, one row per field whose value CHANGED, with the value before
//     (previous_value), the source (a person, the client form, the bill reader…) and, when a
//     person made it, their name (changed_by). Only a named person's change is human_verified.
//
// Values stay in this table, like the project row they came from; nothing here is sent anywhere.
// `intakeFieldAccuracy` returns counts only (field names and numbers, no values) so a back-test can
// be shared without customer data.

import type { AppDb } from "./db";
import { id } from "./ids";
import { nowIso } from "./time";

/** Longer values are narratives (plan-set text, notes), not fields: they are not recorded. */
const MAX_FIELD_CHARS = 500;
/** Keys that are bookkeeping, overlays or markers, never something intake read. */
const NOT_A_FIELD = /^(?:_|planSetExtractedText$|expectedVersion$|clientId$|client_id$)/;

export const INTAKE_SOURCE = "intake";
/** Rows written at creation before v92 said "regex"; they are intake reads too. */
const INTAKE_SOURCES = new Set([INTAKE_SOURCE, "regex"]);

/** Who or what made a change. `person` set = a named person (human_verified). */
export type FieldChangeBy = { person?: string; source?: string };

function fieldText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** The fields of a snapshot this history records: short scalars under ordinary keys. */
export function recordableFields(snapshot: Record<string, unknown> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, raw] of Object.entries(snapshot ?? {})) {
    if (NOT_A_FIELD.test(key)) continue;
    const value = fieldText(raw);
    if (value == null || value.length > MAX_FIELD_CHARS) continue;
    out.set(key, value);
  }
  return out;
}

const INSERT = `INSERT INTO extracted_fields
  (id, project_id, field_name, field_value, previous_value, source_file_id, source_method, confidence, human_verified, changed_by, notes, created_at)
  VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, '', ?)`;

/** The baseline: every field intake read, as it read it. Blank values are not a read. */
export function recordIntakeRead(db: AppDb, projectId: string, snapshot: Record<string, unknown>): number {
  const ts = nowIso();
  let n = 0;
  for (const [field, value] of recordableFields(snapshot)) {
    if (!value) continue;
    db.run(INSERT, [id(), projectId, field, value, null, INTAKE_SOURCE, 0, "", ts]);
    n++;
  }
  return n;
}

/**
 * One row per field whose value differs between `before` and `after` (a field cleared is a change to
 * ""). Returns the changed field names, sorted — never their values (the audit row carries these).
 */
export function recordFieldChanges(
  db: AppDb,
  projectId: string,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  by: FieldChangeBy,
): string[] {
  const was = recordableFields(before);
  const now = recordableFields(after);
  const person = String(by.person ?? "").trim().slice(0, 120);
  const source = person ? "human" : String(by.source ?? "").trim().slice(0, 60) || "system";
  const ts = nowIso();
  const changed: string[] = [];
  for (const field of new Set([...was.keys(), ...now.keys()])) {
    const from = was.get(field) ?? "";
    const to = now.get(field) ?? "";
    if (from === to) continue;
    // A field that only grew past the narrative cap, or a non-scalar, is absent from `now` but
    // still in the snapshot: not a clear, so not recorded.
    if (!now.has(field) && after && Object.prototype.hasOwnProperty.call(after, field) && fieldText(after[field]) !== "") continue;
    db.run(INSERT, [id(), projectId, field, to, from || null, source, person ? 1 : 0, person, ts]);
    changed.push(field);
  }
  return changed.sort();
}

export type FieldChange = { at: string; from: string | null; to: string; source: string; by: string };
export type FieldHistory = {
  field: string;
  /** What intake read; null when intake read nothing for it (or the project predates the record). */
  intakeValue: string | null;
  /** The value after the last recorded change (or intake's read when nothing changed it). */
  currentValue: string;
  /** Later changes, oldest first. Repeats of the same value (pre-v92 full re-writes) are folded out. */
  changes: FieldChange[];
  /** A named person changed it at least once. */
  changedByPerson: boolean;
};

type Row = {
  field_name: string; field_value: string; previous_value: string | null; source_method: string;
  changed_by: string | null; created_at: string;
};

/** Per field: intake's read, then each change after it. Staff view: values are shown as stored. */
export function projectFieldHistory(db: AppDb, projectId: string): FieldHistory[] {
  const rows = db.query<Row>(
    `SELECT field_name, field_value, previous_value, source_method, changed_by, created_at
       FROM extracted_fields WHERE project_id = ? ORDER BY created_at, rowid`,
    [projectId],
  );
  const byField = new Map<string, FieldHistory>();
  for (const r of rows) {
    const field = String(r.field_name);
    const value = String(r.field_value ?? "");
    const source = String(r.source_method ?? "");
    let h = byField.get(field);
    if (!h) {
      h = { field, intakeValue: null, currentValue: "", changes: [], changedByPerson: false };
      byField.set(field, h);
      if (INTAKE_SOURCES.has(source)) {
        h.intakeValue = value;
        h.currentValue = value;
        continue;
      }
    }
    const known = h.changes.length > 0 || h.intakeValue != null;
    if (known && value === h.currentValue) continue;
    const by = String(r.changed_by ?? "").trim();
    h.changes.push({ at: String(r.created_at), from: r.previous_value ?? (known ? h.currentValue : null), to: value, source, by });
    if (source === "human") h.changedByPerson = true;
    h.currentValue = value;
  }
  return [...byField.values()].sort((a, b) => a.field.localeCompare(b.field));
}

export type IntakeFieldAccuracy = {
  field: string;
  /** Projects where intake read a value for this field. */
  read: number;
  /** …of those, a named person later changed it. */
  changedByPerson: number;
  /** …of those, something else changed it (client form, bill reader, a re-parse). */
  changedOtherwise: number;
  /** Projects where intake read nothing and the value came later. */
  filledLater: number;
};

/**
 * Counts only, per field, across projects (optionally one org): how often intake's read stood, was
 * changed by a person, or was filled in later. No values, no project ids — safe to share.
 * Fixtures and demos (learning_excluded) are left out.
 * orgId null = every org (the operator's own back-test). Rows written before v92 marked every save
 * as a person's, so older projects over-count changedByPerson; projects created after it are exact.
 */
export function intakeFieldAccuracy(
  db: AppDb,
  orgId: string | null,
  /** YYYY-MM-DD: only projects created on or after it ('' = all). */
  since = "",
): { projects: number; fields: IntakeFieldAccuracy[] } {
  const where = ["learning_excluded = 0"];
  const params: string[] = [];
  if (orgId !== null) { where.push("org_id = ?"); params.push(orgId); }
  if (since) { where.push("created_at >= ?"); params.push(since); }
  const projects = db.query<{ id: string }>(`SELECT id FROM projects WHERE ${where.join(" AND ")}`, params);
  const stats = new Map<string, IntakeFieldAccuracy>();
  const get = (field: string): IntakeFieldAccuracy => {
    let s = stats.get(field);
    if (!s) { s = { field, read: 0, changedByPerson: 0, changedOtherwise: 0, filledLater: 0 }; stats.set(field, s); }
    return s;
  };
  for (const p of projects) {
    for (const h of projectFieldHistory(db, String(p.id))) {
      const s = get(h.field);
      if (h.intakeValue != null && h.intakeValue !== "") {
        s.read++;
        if (h.changedByPerson) s.changedByPerson++;
        else if (h.changes.length) s.changedOtherwise++;
      } else if (h.currentValue) {
        s.filledLater++;
      }
    }
  }
  const fields = [...stats.values()]
    .filter((s) => s.read || s.filledLater)
    .sort((a, b) => (b.changedByPerson + b.filledLater) - (a.changedByPerson + a.filledLater) || a.field.localeCompare(b.field));
  return { projects: projects.length, fields };
}
