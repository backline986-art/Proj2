// ---------------------------------------------------------------------------
// WHAT DOES THIS JOB INSTALL? (#673)
//
// QC used to assume new PV on every job: a battery-only job, or a battery added to a system that is
// already interconnected, blocked on module make / model / wattage / quantity, DC and AC kW,
// inverter output and the PV breaker, none of which it has. This module answers the scope:
//
//   pv                            new PV, no storage evidence (and the strict default)
//   pv+storage                    new PV with a battery
//   storage-added-to-existing-pv  a battery, no new modules, an existing PV system on site
//   storage-only                  a battery, no new modules, no existing PV
//
// THE STRICT DEFAULT IS PV (owner, 2026-11-09: start from the strictest real requirement). A storage
// scope swaps the PV module blockers for battery blockers, so it is reached only when NOTHING on the
// job names new modules (newModuleEvidence) and either:
//   - the plan set itself says so on BOTH the equipment schedule and the SLD (the parser's
//     newModulesOnSchedule / newModulesOnSld read "no", each cited on the sheet) — never the
//     parser's guess alone; or
//   - a named person set the scope on the job (project_job_scopes, PUT /api/projects/:id/job-scope).
// A person's storage scope on a job whose fields name new modules is a CONFLICT: the evidence wins,
// the PV blockers stay, and QC says why (Helm: no PV blocker disappears on a job whose plan set
// shows new modules anywhere). A person saying "pv" or "pv+storage" is always honoured — it can
// only keep checks, never drop one.
//
// Universal: nothing here names a utility, a portal, a city or a state. Read-only: no write.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { JobScope, JobScopeView, ParserPayload, StorageOperatingMode } from "../../shared/src/types";
import { JOB_SCOPES } from "../../shared/src/types";
import { batteryStatus } from "../../shared/src/batteryControls";
import { existingSystemFromSnapshot } from "./normalize";

function clean(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}

/** A value that says there is nothing ("N/A", "None", "0", "-"): not evidence of a new module.
 *  "TBD" is NOT here — modules still to be chosen are modules. */
const NEGATION = /^(?:n\/?a|none|no|nil|not applicable|no new modules?|-+|0+(?:\.0+)?)$/i;

function names(value: unknown): boolean {
  const v = clean(value);
  return v !== "" && !NEGATION.test(v);
}

/** The scalar fields a NEW module or a new PV array is named in. Existing-system fields
 *  (existingModule*, existingDcKw …) are the system already on the roof, never new PV. */
const NEW_MODULE_FIELDS = [
  "moduleMake", "moduleManufacturer", "moduleModel", "moduleWattage", "moduleWatts", "moduleQty", "moduleQuantity",
  // Microinverters convert PV only: a new micro is a new PV array.
  "pvMicroMake", "pvMicroModel", "pvMicroQty",
] as const;

const YES = /^(?:yes|y|true)$/i;
const NO = /^(?:no|n|false|none)$/i;

function sameKw(a: number, b: number | undefined): boolean {
  return b != null && Number.isFinite(b) && Math.abs(a - b) < 0.01;
}

/**
 * EVERY FIELD ON THE JOB THAT NAMES NEW PV. Any one keeps the job on a PV scope. The DC size counts
 * too, unless it is the existing system's own size (a storage-addition plan set prints the existing
 * array's kW; that is disclosure, not a new array).
 */
export function newModuleEvidence(snapshot: ParserPayload | null | undefined): string[] {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const out: string[] = NEW_MODULE_FIELDS.filter((key) => names(s[key]));
  const arrays = Array.isArray(s.pvArrays) ? s.pvArrays as Array<Record<string, unknown>> : [];
  if (arrays.some((a) => a && typeof a === "object" && (names(a.moduleModel) || Number.parseFloat(clean(a.quantity)) > 0))) out.push("pvArrays");
  for (const key of ["newModulesOnSchedule", "newModulesOnSld"]) if (YES.test(clean(s[key]))) out.push(key);
  const dc = Number.parseFloat(clean(s.dcKw) || clean(s.systemSizeDcKw));
  if (Number.isFinite(dc) && dc > 0) {
    const existing = existingSystemFromSnapshot(s as ParserPayload);
    if (!(existing && (sameKw(dc, existing.existingDcKw) || sameKw(dc, existing.combinedDcKw)))) out.push("dcKw");
  }
  return out;
}

/** The plan set itself states no new modules on BOTH the equipment schedule and the SLD. */
export function planSetStatesNoNewModules(snapshot: ParserPayload | null | undefined): boolean {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  return NO.test(clean(s.newModulesOnSchedule)) && NO.test(clean(s.newModulesOnSld));
}

/** An existing PV system remains in service on site (the existing-system disclosure block). */
export function hasExistingPv(snapshot: ParserPayload | null | undefined): boolean {
  return Boolean(existingSystemFromSnapshot((snapshot ?? {}) as ParserPayload)?.hasExistingSystem);
}

/** Does the scope install new PV? The PV module blockers apply exactly when it does. */
export function scopeHasNewPv(scope: JobScope): boolean {
  return scope === "pv" || scope === "pv+storage";
}

export function isJobScope(value: unknown): value is JobScope {
  return typeof value === "string" && (JOB_SCOPES as readonly string[]).includes(value);
}

/**
 * THE BATTERY'S OPERATING MODE, CLASSIFIED: export, non-export, backup-only, or "" when the words do
 * not say which (self-consumption alone does not say whether it exports). Read from the job's own
 * batteryMode, else its exportMode (the existing-system block's vocabulary: export / non-export-pcs /
 * ngom).
 */
export function storageOperatingMode(snapshot: ParserPayload | null | undefined): StorageOperatingMode | "" {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  for (const key of ["batteryMode", "exportMode"]) {
    const mode = classifyStorageMode(clean(s[key]));
    if (mode) return mode;
  }
  return "";
}

export function classifyStorageMode(raw: string): StorageOperatingMode | "" {
  const v = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!v) return "";
  if (/\bbackup[-\s]?only\b|\bbackup power only\b|\bstand[-\s]?by only\b|\bno grid (?:charging|export) and no parallel\b/.test(v)) return "backup-only";
  if (/\bnon[-\s]?export|\bno[-\s]export|\bzero[-\s]export|\bngom\b|\bexport[-\s]?limit(?:ed|ing)?\s*(?:to\s*)?0(?:\s*kw)?\b/.test(v)) return "non-export";
  if (/\bexport(?:ing|s)?\b/.test(v)) return "export";
  return "";
}

export interface PersonJobScope {
  scope: JobScope;
  setBy: string;
  setAt: string;
}

/** The scope a named person set on the job, or null. Never throws (a pre-v67 schema reads null). */
export function personJobScope(db: AppDb | null, projectId: string): PersonJobScope | null {
  if (!db || !projectId) return null;
  try {
    const row = db.get<{ scope: string; set_by: string; set_at: string }>(
      "SELECT scope, set_by, set_at FROM project_job_scopes WHERE project_id = ?", [projectId]);
    if (!row || !isJobScope(row.scope)) return null;
    return { scope: row.scope, setBy: String(row.set_by || ""), setAt: String(row.set_at || "") };
  } catch {
    return null;
  }
}

const LABEL: Record<JobScope, string> = {
  pv: "new PV",
  "pv+storage": "new PV with storage",
  "storage-added-to-existing-pv": "storage added to an existing PV system",
  "storage-only": "storage only",
};
export function jobScopeLabel(scope: JobScope): string {
  return LABEL[scope];
}

/**
 * THE ONE ANSWER: what this job installs, and why. Pure over the snapshot and the person's setting.
 */
export function deriveJobScope(snapshot: ParserPayload | null | undefined, person: PersonJobScope | null = null): JobScopeView {
  const battery = batteryStatus(snapshot as Record<string, unknown> | undefined) === "yes";
  const evidence = newModuleEvidence(snapshot);
  const existing = hasExistingPv(snapshot);
  const storageScope: JobScope = existing ? "storage-added-to-existing-pv" : "storage-only";
  const personFields = person ? { personScope: person.scope, setBy: person.setBy, setAt: person.setAt } : {};

  // What the evidence alone says.
  let derived: Omit<JobScopeView, "newModuleEvidence" | "conflict">;
  if (evidence.length) {
    derived = battery
      ? { scope: "pv+storage", basis: "plan_set", reason: `The job names new modules (${evidence.join(", ")}) and a battery.` }
      : { scope: "pv", basis: "plan_set", reason: `The job names new modules (${evidence.join(", ")}).` };
  } else if (battery && planSetStatesNoNewModules(snapshot)) {
    derived = {
      scope: storageScope,
      basis: "plan_set",
      reason: `The plan set shows a battery and no new modules on either the equipment schedule or the SLD${existing ? ", with an existing PV system on site" : ""}.`,
    };
  } else {
    derived = {
      scope: "pv",
      basis: "default",
      reason: battery
        ? "A battery is shown, but the plan set does not state that neither the equipment schedule nor the SLD shows new modules, so the PV checks stay. Set the job scope if this job adds no modules."
        : "Nothing on the job settles its scope, so the PV checks apply.",
    };
  }

  if (!person) return { ...derived, newModuleEvidence: evidence, conflict: "" };

  if (!scopeHasNewPv(person.scope) && evidence.length) {
    // The person's storage scope against fields that name new modules: the evidence wins.
    return {
      ...derived,
      newModuleEvidence: evidence,
      conflict: `${person.setBy || "A person"} set this job to ${LABEL[person.scope]}, but the job still names new modules (${evidence.join(", ")}). The PV checks stay until those fields are cleared or the scope is set to ${battery ? "new PV with storage" : "new PV"}.`,
      ...personFields,
    };
  }
  // Storage-only said while an existing PV system is disclosed: the addition's disclosure still owes.
  const scope: JobScope = person.scope === "storage-only" && existing ? "storage-added-to-existing-pv" : person.scope;
  return {
    scope,
    basis: "person",
    reason: scope === person.scope
      ? `Set to ${LABEL[scope]} by ${person.setBy || "a person"}.`
      : `Set to ${LABEL[person.scope]} by ${person.setBy || "a person"}; the job discloses an existing PV system, so it is checked as ${LABEL[scope]}.`,
    newModuleEvidence: evidence,
    conflict: "",
    ...personFields,
  };
}

/** The scope QC uses for a stored project. */
export function resolveJobScope(db: AppDb | null, projectId: string, snapshot: ParserPayload | null | undefined): JobScopeView {
  return deriveJobScope(snapshot, personJobScope(db, projectId));
}

/**
 * A NAMED PERSON sets (or, with null, clears) the job's scope. The only writer of
 * project_job_scopes; the caller audits it and re-runs QC.
 */
export function setPersonJobScope(db: AppDb, projectId: string, scope: JobScope | null, setBy: string): PersonJobScope | null {
  if (scope === null) {
    db.run("DELETE FROM project_job_scopes WHERE project_id = ?", [projectId]);
    return null;
  }
  if (!isJobScope(scope)) throw new Error(`Unknown job scope: ${String(scope)}`);
  const setAt = new Date().toISOString();
  db.run(
    `INSERT INTO project_job_scopes (project_id, scope, set_by, set_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET scope = excluded.scope, set_by = excluded.set_by, set_at = excluded.set_at`,
    [projectId, scope, setBy, setAt],
  );
  return { scope, setBy, setAt };
}
