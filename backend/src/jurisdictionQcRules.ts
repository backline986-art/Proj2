// EACH JURISDICTION'S QC BASELINE SCREENS, AS DATA (review-audit draft 12).
//
// baselineRules.ts used to ask "is this Oregon? is this Portland?" in code: an AHJ-name fallback, the
// legacy prescriptive limits, the Tier 1 export wording, a manual-disconnect screen and Portland's
// submittal list. Those are facts about jurisdictions, so they live in
// backend/data/reference-jurisdiction-qc-rules.json and baselineRules reads them with one generic rule
// per KIND of screen. Adding a state or a city is a record in that file (or a person's / an official
// read's row in state_permit_rules, family "qc"), never code.
//
// Matching (matchJurisdiction):
//   - a STATE record (ahj "") applies when the job's state IS its state, or, when the job names no
//     state at all, when the AHJ contains one of its ahjNames (lower-case substring). A job that names
//     another state never matches by AHJ ("Portland" Maine stays Maine);
//   - a CITY record (ahj set) applies inside its state record's match when the AHJ contains one of its
//     ahjNames;
//   - the LABEL record is the state record whose state is the job's state, or whose name the AHJ
//     contains (how the screens have always named the jurisdiction).
//
// Severity, the Helm #637 bar: a screen may ask for a blocker; it blocks only when a person recorded it,
// or it quotes its source verbatim and names it (an official read, or a seeded row with a quote, a
// source name and a URL). Everything else warns. Every shipped screen warns.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrescriptiveLimits, Severity, StatePermitRule } from "../../shared/src/types";
import type { AppDb } from "./db";
import { usStateCode } from "./permitPath";

export type JurisdictionScreenKind = "manual_disconnect" | "submittal_documents";
export const JURISDICTION_SCREEN_KINDS: readonly JurisdictionScreenKind[] = ["manual_disconnect", "submittal_documents"];
/** What a submittal-documents screen can ask the package to show (read per kind in baselineRules). */
export type SubmittalItemKey = "site_plan" | "fire_access_path" | "roof_framing" | "roof_cross_section" | "racking_attachment";
export const SUBMITTAL_ITEM_KEYS: readonly SubmittalItemKey[] = ["site_plan", "fire_access_path", "roof_framing", "roof_cross_section", "racking_attachment"];

export type JurisdictionScreenTier = "seeded" | "official" | "verified";

export interface JurisdictionQcScreen {
  kind: JurisdictionScreenKind;
  ruleId: string;
  ruleName: string;
  /** {missing} is the list of missing items (submittal_documents). */
  message: string;
  fieldName: string;
  items?: Array<{ key: SubmittalItemKey; label: string }>;
  /** Asked-for severity; honoured only when jurisdictionScreenMayBlock (the #637 bar). */
  severity?: "warning" | "blocker";
  source?: string;
  sourceUrl?: string;
  /** The source's own words, verbatim. */
  quote?: string;
  tier: JurisdictionScreenTier;
}

export interface JurisdictionPrescriptive {
  /** The jurisdiction publishes a prescriptive rooftop-PV path: the screens run on the context's limits. */
  publishesPath?: boolean;
  source?: string;
  /** The limits screened when the caller passes no code context. */
  defaults?: PrescriptiveLimits;
  /** Rule ids the screens keep for this jurisdiction (QC history, blocker gating and goldens key on them). */
  ruleIds?: Partial<Record<PrescriptiveScreen, string>>;
  /** The export screen's own name and words ({dcKw}, {combinedNote}, {exportKw}). */
  exportScreen?: { ruleName: string; message: string; source?: string };
}
export type PrescriptiveScreen = "snow" | "dead" | "framing" | "wind" | "fire" | "export";
const PRESCRIPTIVE_SCREENS: readonly PrescriptiveScreen[] = ["snow", "dead", "framing", "wind", "fire", "export"];

export interface JurisdictionQcRecord {
  state: string;
  /** "" = the state itself; else the city / county this record narrows to. */
  ahj: string;
  displayName: string;
  ahjNames: string[];
  prescriptive?: JurisdictionPrescriptive;
  screens: JurisdictionQcScreen[];
}

export interface ShippedJurisdictionRuleDefinition {
  id: string;
  ruleType: "qc" | "correction" | "monitor";
  name: string;
  jurisdictionScope: string;
  utilityScope: string;
  source: string;
  severity: Severity;
  trigger: string;
  action: string;
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const RULE_ID = /^[a-z0-9][a-z0-9_-]{2,60}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,60}$/;

function sanitizeScreen(raw: unknown, tier: JurisdictionScreenTier): JurisdictionQcScreen | null {
  const o = obj(raw);
  const kind = str(o.kind) as JurisdictionScreenKind;
  if (!JURISDICTION_SCREEN_KINDS.includes(kind)) return null;
  const ruleId = str(o.ruleId);
  const ruleName = str(o.ruleName);
  const message = str(o.message);
  const fieldName = str(o.fieldName);
  if (!RULE_ID.test(ruleId) || !ruleName || !message || !FIELD.test(fieldName)) return null;
  const items = (Array.isArray(o.items) ? o.items : []).map((i) => obj(i))
    .map((i) => ({ key: str(i.key) as SubmittalItemKey, label: str(i.label) }))
    .filter((i) => SUBMITTAL_ITEM_KEYS.includes(i.key) && i.label);
  if (kind === "submittal_documents" && !items.length) return null;
  return {
    kind, ruleId, ruleName, message, fieldName,
    ...(items.length ? { items } : {}),
    ...(str(o.severity) === "blocker" ? { severity: "blocker" as const } : {}),
    ...(str(o.source) ? { source: str(o.source) } : {}),
    ...(/^https?:\/\//i.test(str(o.sourceUrl)) ? { sourceUrl: str(o.sourceUrl) } : {}),
    ...(str(o.quote) ? { quote: str(o.quote) } : {}),
    tier,
  };
}

function sanitizePrescriptive(raw: unknown): JurisdictionPrescriptive | undefined {
  const o = obj(raw);
  if (!Object.keys(o).length) return undefined;
  const ids = obj(o.ruleIds);
  const ruleIds: Partial<Record<PrescriptiveScreen, string>> = {};
  for (const k of PRESCRIPTIVE_SCREENS) if (RULE_ID.test(str(ids[k]))) ruleIds[k] = str(ids[k]);
  const ex = obj(o.exportScreen);
  const defaults = obj(o.defaults);
  return {
    ...(o.publishesPath === true ? { publishesPath: true } : {}),
    ...(str(o.source) ? { source: str(o.source) } : {}),
    ...(Object.keys(defaults).length ? { defaults: defaults as PrescriptiveLimits } : {}),
    ...(Object.keys(ruleIds).length ? { ruleIds } : {}),
    ...(str(ex.ruleName) && str(ex.message) ? { exportScreen: { ruleName: str(ex.ruleName), message: str(ex.message), ...(str(ex.source) ? { source: str(ex.source) } : {}) } } : {}),
  };
}

function sanitizeRecord(raw: unknown): JurisdictionQcRecord | null {
  const o = obj(raw);
  const state = usStateCode(str(o.state));
  const displayName = str(o.displayName);
  const ahjNames = (Array.isArray(o.ahjNames) ? o.ahjNames : []).map((n) => str(n).toLowerCase()).filter(Boolean);
  if (!state || !displayName) return null;
  const ahj = str(o.ahj);
  if (ahj && !ahjNames.length) return null;
  const screens = (Array.isArray(o.screens) ? o.screens : []).map((s) => sanitizeScreen(s, "seeded")).filter((s): s is JurisdictionQcScreen => s != null);
  const prescriptive = ahj ? undefined : sanitizePrescriptive(o.prescriptive);
  return { state, ahj, displayName, ahjNames, ...(prescriptive ? { prescriptive } : {}), screens };
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
function referencePath(): string {
  const explicit = str(process.env.JURISDICTION_QC_RULES_REFERENCE_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(moduleDir, "..", "data", "reference-jurisdiction-qc-rules.json");
}

interface ShippedFile { records: JurisdictionQcRecord[]; ruleDefinitions: ShippedJurisdictionRuleDefinition[] }
let cache: { file: string; data: ShippedFile } | null = null;
function shippedFile(filePath = referencePath()): ShippedFile {
  if (cache && cache.file === filePath) return cache.data;
  const data: ShippedFile = { records: [], ruleDefinitions: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Obj;
    data.records = (Array.isArray(raw.records) ? raw.records : []).map(sanitizeRecord).filter((r): r is JurisdictionQcRecord => r != null);
    for (const d of Array.isArray(raw.ruleDefinitions) ? raw.ruleDefinitions : []) {
      const o = obj(d);
      const ruleType = str(o.ruleType);
      const severity = str(o.severity);
      const def: ShippedJurisdictionRuleDefinition = {
        id: str(o.id), ruleType: (ruleType === "monitor" || ruleType === "correction" ? ruleType : "qc"), name: str(o.name),
        jurisdictionScope: str(o.jurisdictionScope), utilityScope: str(o.utilityScope), source: str(o.source),
        severity: (severity === "blocker" || severity === "info" ? severity : "warning") as Severity, trigger: str(o.trigger), action: str(o.action),
      };
      if (RULE_ID.test(def.id) && def.name) data.ruleDefinitions.push(def);
    }
  } catch { /* a missing or broken file is no data */ }
  cache = { file: filePath, data };
  return data;
}

/** The shipped records (read once per file; a missing or broken file is no records). */
export function shippedJurisdictionQcRecords(filePath = referencePath()): JurisdictionQcRecord[] {
  return shippedFile(filePath).records;
}
/** The `rules` catalogue entries the shipped data defines, in catalogue order. */
export function shippedJurisdictionRuleDefinitions(filePath = referencePath()): ShippedJurisdictionRuleDefinition[] {
  return shippedFile(filePath).ruleDefinitions;
}

export interface JurisdictionMatch {
  /** The state record the job falls under (by its state, or by its AHJ when it names no state). */
  stateRecord: JurisdictionQcRecord | null;
  /** City / county records inside it whose names the AHJ contains. */
  cityRecords: JurisdictionQcRecord[];
  /** The state record that names the job's jurisdiction (its state, or a state name in the AHJ). */
  labelRecord: JurisdictionQcRecord | null;
}

/** Which records a job falls under. `state` is the job's state as written (upper-cased by the caller). */
export function matchJurisdiction(records: JurisdictionQcRecord[], state: string, ahj: string): JurisdictionMatch {
  const ahjText = ahj.toLowerCase();
  const states = records.filter((r) => !r.ahj);
  const stateRecord = states.find((r) => state === r.state)
    ?? (!state ? states.find((r) => r.ahjNames.some((n) => ahjText.includes(n))) : undefined)
    ?? null;
  const cityRecords = stateRecord
    ? records.filter((r) => r.ahj && r.state === stateRecord.state && r.ahjNames.some((n) => ahjText.includes(n)))
    : [];
  const labelRecord = states.find((r) => state === r.state || ahjText.includes(r.displayName.toLowerCase())) ?? null;
  return { stateRecord, cityRecords, labelRecord };
}

/** The record whose prescriptive rule ids a screen-id prefix ("or", "wa", …) names. */
export function recordForIdPrefix(records: JurisdictionQcRecord[], prefix: string): JurisdictionQcRecord | null {
  return records.find((r) => !r.ahj && r.state.toLowerCase() === prefix && r.prescriptive?.ruleIds) ?? null;
}

/** THE #637 BAR: only a person's screen, or one that quotes its named source verbatim, may block. */
export function jurisdictionScreenMayBlock(s: JurisdictionQcScreen): boolean {
  if (s.tier === "verified") return true;
  if (!s.quote) return false;
  if (s.tier === "official") return Boolean(s.sourceUrl);
  return Boolean(s.source && s.sourceUrl);
}

const TIER_RANK: Record<JurisdictionScreenTier, number> = { seeded: 0, official: 1, verified: 2 };

/** A state_permit_rules row of family "qc" as a screen: rule_key is the ruleId, value_json the screen,
 *  citation the source's words, source_url where they were read, confidence the tier. */
function screenFromRow(row: StatePermitRule, base?: JurisdictionQcScreen): JurisdictionQcScreen | null {
  const v = obj(row.value);
  return sanitizeScreen({
    ...(base ?? {}),
    ...v,
    ruleId: row.key,
    quote: row.citation || base?.quote,
    sourceUrl: row.sourceUrl || base?.sourceUrl,
  }, row.confidence);
}

/** Overlay a state's "qc" rows on the shipped records: per ruleId, a row of the same or a higher tier
 *  replaces the shipped screen's fields (rule 3: a person's screen is never replaced by a lower tier);
 *  a row for a new ruleId adds a screen to the state record, or, with ahjNames, to that city's record. */
export function overlayJurisdictionRows(records: JurisdictionQcRecord[], rows: StatePermitRule[]): JurisdictionQcRecord[] {
  if (!rows.length) return records;
  const out = records.map((r) => ({ ...r, screens: [...r.screens] }));
  for (const row of rows) {
    const state = usStateCode(row.state);
    if (!state) continue;
    let placed = false;
    for (const r of out) {
      if (r.state !== state) continue;
      const i = r.screens.findIndex((s) => s.ruleId === row.key);
      if (i < 0) continue;
      placed = true;
      if (TIER_RANK[row.confidence] < TIER_RANK[r.screens[i].tier]) break;
      const s = screenFromRow(row, r.screens[i]);
      if (s) r.screens[i] = s;
      break;
    }
    if (placed) continue;
    const s = screenFromRow(row);
    if (!s) continue;
    const names = (Array.isArray(obj(row.value).ahjNames) ? obj(row.value).ahjNames as unknown[] : []).map((n) => str(n).toLowerCase()).filter(Boolean);
    let target = names.length
      ? out.find((r) => r.ahj && r.state === state && r.ahjNames.some((n) => names.includes(n)))
      : out.find((r) => !r.ahj && r.state === state);
    if (!target) {
      target = { state, ahj: names.length ? str(obj(row.value).ahj) || names[0] : "", displayName: str(obj(row.value).displayName) || state, ahjNames: names, screens: [] };
      out.push(target);
    }
    target.screens.push(s);
  }
  return out;
}

/** The records QC reads for a job: the shipped seed, overlaid by the state's "qc" rows in
 *  state_permit_rules. With no DB, the shipped seed alone. */
export function resolveJurisdictionQcRecords(db: AppDb | null, state: string, ahj: string): JurisdictionQcRecord[] {
  const shipped = shippedJurisdictionQcRecords();
  if (!db) return shipped;
  const code = usStateCode(state) || matchJurisdiction(shipped, state.toUpperCase(), ahj).stateRecord?.state || "";
  if (!code) return shipped;
  return overlayJurisdictionRows(shipped, qcRowsFor(db, code));
}

/** A state's family "qc" rows (the same read as stateRules.statePermitRulesFor, kept here so the QC
 *  baseline, which db.ts loads for the rules catalogue, imports nothing that imports the DB layer). */
function qcRowsFor(db: AppDb, state: string): StatePermitRule[] {
  return db.query<Obj>(
    "SELECT state, rule_key, value_json, citation, source_url, confidence, verified_at, fetched_at FROM state_permit_rules WHERE state = ? AND family = 'qc' ORDER BY rule_key",
    [state],
  ).map((row) => {
    let value: unknown = null;
    try { value = JSON.parse(String(row.value_json ?? "null")); } catch { value = null; }
    return {
      state: String(row.state), family: "qc" as const, key: String(row.rule_key), value,
      citation: String(row.citation ?? ""), sourceUrl: String(row.source_url ?? ""),
      confidence: String(row.verified_at ?? "") ? "verified" as const : String(row.confidence ?? "") === "official" ? "official" as const : "seeded" as const,
      ...(String(row.fetched_at ?? "") ? { fetchedAt: String(row.fetched_at) } : {}),
    };
  });
}
