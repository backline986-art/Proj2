// EACH JURISDICTION'S PRESCRIPTIVE ROOFTOP-PV PATH, AS DATA (review-audit draft 14).
//
// permitPath.ts used to decide the prescriptive-vs-engineered split with `usStateCode(state) === "OR"`:
// Oregon's limits, its roofing row and the ORSC / BCD 440-5952 wording sat in code, so a second state
// that publishes the same kind of path (two applications, the AHJ takes one) could only be added by
// editing the resolver. Those are facts about jurisdictions, so they live in
// backend/data/reference-jurisdiction-permit-paths.json and permitPath reads them with one generic rule.
// Adding a state's or a city's prescriptive path is a record in that file, never code.
//
// Matching (permitPathRecordFor):
//   - only a state that NORMALISES (usStateCode) can match. An unrecognised spelling matches nothing,
//     so the resolver keeps asking for the state instead of guessing (fail-closed, as before);
//   - an AHJ record (ahj set) applies inside its state when the job's AHJ contains one of its ahjNames,
//     and wins over the state record;
//   - else the state record (ahj "").
// The record's limits are what the screen runs on; a person-verified code profile's stated limits
// overlay them (permitPath.resolvePermitPath, opts.limitsTier), a seeded one never does.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usStateCode } from "./usState";

/** The limits a prescriptive screen runs on (the same fields evaluatePrescriptiveCriteria reads). */
export interface PathScreenLimits {
  maxGroundSnowPsf?: number;
  maxPvDeadLoadPsf?: number;
  maxRafterSpacingIn?: number;
  allowedWindExposures?: string[];
  maxWindSpeedMphExpC?: number;
  maxWindSpeedMphExpB?: number;
  maxModuleHeightIn?: number;
  maxRoofLayers?: number;
}

/** Which coverings a prescriptive path's roofing row admits: metal or not, and the most layers of
 *  composition / wood it takes (absent = that covering is not admitted). Tile, membrane and slate are
 *  never admitted by this shape (no published row on file admits them). */
export interface RoofingRowAllowance {
  metal?: boolean;
  compositionLayers?: number;
  woodLayers?: number;
}

export interface RoofingRowRecord {
  /** How the jurisdiction's own form names the row ("the BCD 5952 roofing row"). */
  name: string;
  allows: RoofingRowAllowance;
  /** The row's words for what it admits, in the tile sentence ("only metal, … composition"). */
  admits: string;
  /** The short list of eligible coverings, in the membrane / slate sentence. */
  eligible: string;
  /** The row's words for its layer limit, in the too-many-layers sentence. */
  layersLimit: string;
}

export interface JurisdictionPermitPathRecord {
  state: string;
  /** "" = the state itself; else the AHJ this record narrows to. */
  ahj: string;
  displayName: string;
  ahjNames: string[];
  /** The jurisdiction publishes two applications (prescriptive / structural) and takes exactly one. */
  split: boolean;
  /** The code the screen's words cite ("ORSC / BCD 440-5952"). */
  code: string;
  source: string;
  sourceUrl?: string;
  /** These limits sit under evaluatePrescriptiveCriteria when a caller asks for defaults. */
  criteriaDefault: boolean;
  limits: PathScreenLimits;
  roofingRow?: RoofingRowRecord;
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const posNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

const NUMERIC_LIMITS = ["maxGroundSnowPsf", "maxPvDeadLoadPsf", "maxRafterSpacingIn", "maxWindSpeedMphExpC", "maxWindSpeedMphExpB", "maxModuleHeightIn", "maxRoofLayers"] as const;

/** Only the fields a screen reads, each a positive number (exposures: a list of single letters). */
export function sanitizePathLimits(raw: unknown): PathScreenLimits {
  const o = obj(raw);
  const out: PathScreenLimits = {};
  for (const k of NUMERIC_LIMITS) {
    const n = posNum(o[k]);
    if (n != null) out[k] = n;
  }
  const exp = (Array.isArray(o.allowedWindExposures) ? o.allowedWindExposures : []).map((e) => str(e).toUpperCase()).filter((e) => /^[A-D]$/.test(e));
  if (exp.length) out.allowedWindExposures = exp;
  return out;
}

function sanitizeRoofingRow(raw: unknown): RoofingRowRecord | undefined {
  const o = obj(raw);
  const a = obj(o.allows);
  const allows: RoofingRowAllowance = {
    ...(a.metal === true ? { metal: true } : {}),
    ...(posNum(a.compositionLayers) != null ? { compositionLayers: posNum(a.compositionLayers) } : {}),
    ...(posNum(a.woodLayers) != null ? { woodLayers: posNum(a.woodLayers) } : {}),
  };
  const row = { name: str(o.name), allows, admits: str(o.admits), eligible: str(o.eligible), layersLimit: str(o.layersLimit) };
  return row.name && row.admits && row.eligible && row.layersLimit ? row : undefined;
}

function sanitizeRecord(raw: unknown): JurisdictionPermitPathRecord | null {
  const o = obj(raw);
  const state = usStateCode(str(o.state));
  const displayName = str(o.displayName);
  const code = str(o.code);
  const ahj = str(o.ahj);
  const ahjNames = (Array.isArray(o.ahjNames) ? o.ahjNames : []).map((n) => str(n).toLowerCase()).filter(Boolean);
  // A record must say WHERE (a recognised state), WHO (a name to print) and WHICH code its words cite;
  // an AHJ record must also say how the AHJ is named. Anything less is no record (never a guess).
  if (!state || !displayName || !code || (ahj && !ahjNames.length) || o.split !== true) return null;
  const roofingRow = sanitizeRoofingRow(o.roofingRow);
  return {
    state, ahj, displayName, ahjNames, split: true, code,
    source: str(o.source),
    ...(/^https?:\/\//i.test(str(o.sourceUrl)) ? { sourceUrl: str(o.sourceUrl) } : {}),
    criteriaDefault: o.criteriaDefault === true && !ahj,
    limits: sanitizePathLimits(o.limits),
    ...(roofingRow ? { roofingRow } : {}),
  };
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
function referencePath(): string {
  const explicit = str(process.env.JURISDICTION_PERMIT_PATHS_REFERENCE_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(moduleDir, "..", "data", "reference-jurisdiction-permit-paths.json");
}

let cache: { file: string; records: JurisdictionPermitPathRecord[] } | null = null;
/** The shipped records (read once per file; a missing or broken file is no records, so every state
 *  falls back to its own researched data or the standard review, never to a borrowed screen). */
export function shippedPermitPathRecords(filePath = referencePath()): JurisdictionPermitPathRecord[] {
  if (cache && cache.file === filePath) return cache.records;
  let records: JurisdictionPermitPathRecord[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Obj;
    records = (Array.isArray(raw.records) ? raw.records : []).map(sanitizeRecord).filter((r): r is JurisdictionPermitPathRecord => r != null);
  } catch { /* a missing or broken file is no data */ }
  cache = { file: filePath, records };
  return records;
}

/** The record a job's prescriptive path comes from, or null (no published path on file). */
export function permitPathRecordFor(state: unknown, ahj?: unknown): JurisdictionPermitPathRecord | null {
  const code = usStateCode(state);
  if (!code) return null;
  const records = shippedPermitPathRecords().filter((r) => r.state === code);
  const ahjText = str(ahj).toLowerCase();
  return (ahjText ? records.find((r) => r.ahj && r.ahjNames.some((n) => ahjText.includes(n))) : undefined)
    ?? records.find((r) => !r.ahj)
    ?? null;
}

/** The state-level records, in file order (the wording that names where a split exists reads them). */
export function statewidePathRecords(): JurisdictionPermitPathRecord[] {
  return shippedPermitPathRecords().filter((r) => !r.ahj);
}

/** The limits evaluatePrescriptiveCriteria puts underneath a caller's own when it asks for defaults:
 *  the criteriaDefault record's, else none (every row then answers from the caller's limits alone). */
export function criteriaDefaultLimits(): PathScreenLimits {
  return statewidePathRecords().find((r) => r.criteriaDefault)?.limits ?? {};
}

/** "X's CODE" for each state-level record, joined: the screens the resolver can run. */
export function splitScreenNames(fmt: (r: JurisdictionPermitPathRecord) => string): string {
  const names = statewidePathRecords().map(fmt);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
