// ---------------------------------------------------------------------------
// THE JOB'S CLASS, AND THE HOLD IT PUTS ON AUTOMATION (#688).
//
// Nothing in the data model said residential or commercial. In a soft run of invented commercial
// jobs (30 to 750 kW) every one passed intake QC, a 750 kW ground mount resolved to a utility's
// residential net-metering portal as an "NEM application" and would have replayed a residential
// recipe's answers, and every job merged into the shared AHJ and utility knowledge rows. Occupancy
// fields were inert: a job with every occupancy field set to "Commercial" produced byte-identical
// output.
//
// This module is the ONE answer to "may automation work this job as residential?". It is pure:
// a ProjectRecord (and any cited caps) in, a ProjectClassStatus out. Every door that opens a
// portal, replays a recipe, learns a portal or writes shared knowledge from a job asks
// `projectClassStatus(...).held` (backend: repository.projectClassHoldReason /
// knowledgeBase.isLearningExcluded), and a held job is left to a person.
//
// THE RULES (owner, 2026-11-09: the strictest real requirement is the default, per-authority data
// relaxes it; keep it universal — no utility, city or state is named here):
//   - A job a person set to "commercial" is held. Always.
//   - A deterministic screen raises "probably commercial — confirm class" when the job's own
//     evidence says so: the occupancy / structure / customer type is not a dwelling; the service is
//     three-phase or a 208/277/480/600 V (wye) service; or the DC or AC size exceeds the residential
//     cap. With a verbatim-cited per-authority cap (#679's record, passed in as `caps`) that cap
//     is the limit and crossing it is a BLOCKER (Helm's #637 bar); with no cited cap, one strict
//     default of 25 kW applies, as a WARNING. Either way an unconfirmed signal HOLDS the job.
//   - A named person clears the flag by confirming the class. The confirmation records the signal
//     keys it covered, and each key carries its evidence: a job confirmed residential at 30 kW
//     that is re-drawn at 400 kW is flagged again.
//   - Unknown is residential with today's checks. A job with no evidence of any kind raises no
//     signal and is never held: nothing here relaxes, reorders or replaces an existing gate.
// ---------------------------------------------------------------------------
import type {
  ProjectClass,
  ProjectClassConfirmation,
  ProjectClassSignal,
  ProjectClassStatus,
  ProjectRecord,
  ResidentialCapCitation,
} from "./types";

/** THE STRICT DEFAULT (owner rule: strictest real requirement first). 25 kW is the lowest
 *  residential customer-generation cap in the programs the commercial research read; with no cited
 *  cap for the job's authority, a job above it is flagged as a WARNING (never a blocker) and held
 *  until a person confirms the class. Per-authority cited data replaces it (`caps`). */
export const DEFAULT_RESIDENTIAL_CAP_KW = 25;

type ClassInput = Pick<ProjectRecord, "systemSizeDcKw" | "systemSizeAcKw" | "parserSnapshot">
  & Partial<Pick<ProjectRecord, "projectClass" | "projectClassConfirmation" | "servicePhase" | "serviceVoltage">>;

function str(v: unknown): string {
  return v == null ? "" : String(v).replace(/\s+/g, " ").trim();
}
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = str(v).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned[0]);
  return Number.isFinite(n) ? n : null;
}
function snap(input: ClassInput): Record<string, unknown> {
  return (input.parserSnapshot ?? {}) as Record<string, unknown>;
}

/** The class as stored; anything but "commercial" is residential (unknown stays residential). */
export function normalizeProjectClass(v: unknown): ProjectClass {
  return str(v).toLowerCase() === "commercial" ? "commercial" : "residential";
}

/** The service phase the plan set states: the parser key first, the legacy key as fallback. */
export function servicePhaseOf(snapshot: Record<string, unknown> | undefined): string {
  const s = snapshot ?? {};
  return str(s.servicePhase) || str(s.phase);
}
/** The service voltage the plan set states: the parser key first, then the legacy keys. */
export function serviceVoltageOf(snapshot: Record<string, unknown> | undefined): string {
  const s = snapshot ?? {};
  return str(s.serviceVoltage) || str(s.voltage) || str(s.serviceType);
}

// ── NON-DWELLING EVIDENCE ────────────────────────────────────────────────────────────────
// The fields a person or the parser answers about WHAT the building / customer is. Read as
// stated; a field that is empty says nothing (unknown stays residential).
const USE_FIELDS = [
  "occupancyType", "occupancy", "occupancyGroup", "constructionCategory", "buildingType",
  "buildingUse", "propertyType", "customerType", "structureDescription",
];
// Words that name a non-dwelling use. "residential" never cancels them ("non-residential",
// "mixed-use commercial/residential" are flagged — a person confirms).
const NON_DWELLING = /\b(?:commercial|industrial|agricultur\w*|warehouse|(?<!home\s)office|retail|mercantile|school|educational|church|worship|municipal|government\w*|non[- ]?residential|manufacturing|factory|hospital|clinic|hotel|motel|restaurant|parking\s+(?:structure|garage|lot)|irrigation|utility[- ]scale|solar\s+farm|data\s+center)\b/i;
// An IBC occupancy group that is not residential, as a whole field value ("B", "S-1", "M / S-2").
// R (residential) and U (utility/accessory: also a house's detached garage) never count.
const NON_DWELLING_GROUP_VALUE = /^(?:(?:occupancy\s+)?group\s*)?[ABEFHIMS](?:-\d)?(?:\s*[/,&]\s*[ABEFHIMSU](?:-\d)?)*$/i;
// The same group stated in the plan set's own notes ("Building occupancy group S-1 / B").
// "Occupancy category" is the structural RISK category (I-IV), never an occupancy group.
const NON_DWELLING_GROUP_TEXT = /\boccupancy\s+(?:group|classification)\s*:?\s*(?:group\s*)?([ABEFHIMS](?:-\d)?)\b/i;
const NOTE_FIELDS = ["sitePlanNotesText", "projectDescriptionText", "planSetExtractedText", "description"];

function nonDwellingSignal(input: ClassInput): ProjectClassSignal | null {
  const s = snap(input);
  for (const field of USE_FIELDS) {
    const value = str(s[field]);
    if (!value) continue;
    const isGroupField = /occupancy/i.test(field);
    if (NON_DWELLING.test(value) || (isGroupField && NON_DWELLING_GROUP_VALUE.test(value))) {
      return {
        code: "occupancy.non_dwelling",
        key: `occupancy.non_dwelling|${field}=${value.toLowerCase().slice(0, 80)}`,
        severity: "warning",
        message: `${field} reads "${value.slice(0, 80)}" — not a dwelling.`,
        fieldName: field,
      };
    }
  }
  for (const field of NOTE_FIELDS) {
    const m = str(s[field]).match(NON_DWELLING_GROUP_TEXT);
    if (!m) continue;
    return {
      code: "occupancy.non_dwelling",
      key: `occupancy.non_dwelling|${field}:group=${m[1].toUpperCase()}`,
      severity: "warning",
      message: `The plan set's notes state occupancy group ${m[1].toUpperCase()} — not a residential (R) occupancy.`,
      fieldName: field,
    };
  }
  return null;
}

// ── SERVICE EVIDENCE ─────────────────────────────────────────────────────────────────────
const THREE_PHASE = /\b(?:three|3)[- ]?(?:phase|ph)\b|\b3\s*(?:ϕ|φ|Ø)|^3$/i;
// 208/277/480/600 V, or any wye ("208Y/120", "277/480Y", "wye"). 120/240 and 240 never match.
const COMMERCIAL_VOLTAGE = /(?:^|[^\d.])(?:208|277|480|600)(?![\d.])|\d\s*Y\b|\bY\s*\/|\bwye\b/i;

function serviceSignal(input: ClassInput): ProjectClassSignal | null {
  const s = snap(input);
  const phase = str(input.servicePhase) || servicePhaseOf(s);
  if (phase && THREE_PHASE.test(phase)) {
    return {
      code: "service.three_phase",
      key: `service.three_phase|phase=${phase.toLowerCase().slice(0, 40)}`,
      severity: "warning",
      message: `The service is three-phase ("${phase.slice(0, 40)}").`,
      fieldName: "servicePhase",
    };
  }
  const voltages: Array<[string, string]> = [
    ["serviceVoltage", str(input.serviceVoltage) || str(s.serviceVoltage) || str(s.voltage)],
    ["serviceType", str(s.serviceType)],
  ];
  for (const [field, value] of voltages) {
    if (!value) continue;
    if (THREE_PHASE.test(value) || COMMERCIAL_VOLTAGE.test(value)) {
      return {
        code: "service.three_phase",
        key: `service.three_phase|${field}=${value.toLowerCase().slice(0, 40)}`,
        severity: "warning",
        message: `The service reads "${value.slice(0, 40)}" — a three-phase / commercial voltage service.`,
        fieldName: field,
      };
    }
  }
  return null;
}

// ── SIZE EVIDENCE ────────────────────────────────────────────────────────────────────────
/** The largest size the job states on this basis: the project field, the parser's own keys and
 *  the combined (new + existing) figure — the cap binds the generator as a whole. */
export function screenedKw(input: ClassInput, basis: "dc" | "ac"): number | null {
  const s = snap(input);
  const vals = basis === "dc"
    ? [input.systemSizeDcKw, s.dcKw, s.systemSizeDcKw, s.combinedDcKw]
    : [input.systemSizeAcKw, s.acKw, s.systemSizeAcKw, s.combinedAcKw];
  const nums = vals.map(num).filter((n): n is number => n != null && n > 0);
  return nums.length ? Math.max(...nums) : null;
}

/** May this cited cap BLOCK? Only with a named source, its URL, and a verbatim quote that carries
 *  the cap's own value (Helm's #637 bar). Anything less is a warning. */
export function capCitationBlocks(cap: ResidentialCapCitation): boolean {
  if (!str(cap.sourceName) || !/^https?:\/\//i.test(str(cap.sourceUrl))) return false;
  const quote = str(cap.quote);
  if (!quote) return false;
  const value = String(cap.valueKw);
  return new RegExp(`(?:^|[^\\d.])${value.replace(".", "\\.")}(?![\\d]|\\.\\d)`).test(quote);
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function sizeSignals(input: ClassInput, caps: ResidentialCapCitation[]): ProjectClassSignal[] {
  const out: ProjectClassSignal[] = [];
  const cited = caps.filter((c) => c && Number.isFinite(c.valueKw) && c.valueKw > 0);
  for (const basis of ["dc", "ac"] as const) {
    const kw = screenedKw(input, basis);
    if (kw == null) continue;
    const label = basis.toUpperCase();
    if (cited.length) {
      // Cited data replaces the default entirely: the authority's own limit, on its own basis.
      for (const cap of cited.filter((c) => c.basis === basis)) {
        if (kw <= cap.valueKw) continue;
        const blocks = capCitationBlocks(cap);
        out.push({
          code: `size.${basis}_over_cap`,
          key: `size.${basis}_over_cap|${fmt(kw)}>${fmt(cap.valueKw)}`,
          severity: blocks ? "blocker" : "warning",
          message: `${label} size ${fmt(kw)} kW exceeds the ${fmt(cap.valueKw)} kW residential cap (${str(cap.sourceName) || "cited source"}${blocks ? `: "${str(cap.quote).slice(0, 160)}"` : ", not quoted verbatim"}).`,
          fieldName: basis === "dc" ? "systemSizeDcKw" : "systemSizeAcKw",
        });
        break;
      }
      continue;
    }
    if (kw > DEFAULT_RESIDENTIAL_CAP_KW) {
      out.push({
        code: `size.${basis}_over_cap`,
        key: `size.${basis}_over_cap|${fmt(kw)}>${fmt(DEFAULT_RESIDENTIAL_CAP_KW)}`,
        severity: "warning",
        message: `${label} size ${fmt(kw)} kW exceeds ${DEFAULT_RESIDENTIAL_CAP_KW} kW, the strict default residential cap (no cited cap is on file for this job's utility).`,
        fieldName: basis === "dc" ? "systemSizeDcKw" : "systemSizeAcKw",
      });
    }
  }
  return out;
}

/** THE SCREEN: every "probably commercial" signal the job's own evidence raises. Pure. */
export function screenProjectClass(input: ClassInput, caps: ResidentialCapCitation[] = []): ProjectClassSignal[] {
  return [nonDwellingSignal(input), serviceSignal(input), ...sizeSignals(input, caps)]
    .filter((sig): sig is ProjectClassSignal => Boolean(sig));
}

/** A stored confirmation, or null when it is unreadable or names nobody. */
export function parseProjectClassConfirmation(raw: unknown): ProjectClassConfirmation | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const by = str(o.by);
  if (!by) return null;
  return {
    by,
    at: str(o.at),
    projectClass: normalizeProjectClass(o.projectClass),
    signalKeys: Array.isArray(o.signalKeys) ? o.signalKeys.map((k) => String(k)) : [],
  };
}

export const COMMERCIAL_HOLD_LABEL = "Commercial job — held for a person";
export const PROBABLY_COMMERCIAL_LABEL = "Probably commercial — confirm class";

/** WHERE THE JOB STANDS: the one predicate every door reads. Pure. */
export function projectClassStatus(input: ClassInput, caps: ResidentialCapCitation[] = []): ProjectClassStatus {
  const projectClass = normalizeProjectClass(input.projectClass);
  const confirmation = input.projectClassConfirmation ? parseProjectClassConfirmation(input.projectClassConfirmation) : null;
  const signals = screenProjectClass(input, caps);
  const confirmedKeys = new Set(confirmation ? confirmation.signalKeys : []);
  const unconfirmed = signals.filter((sig) => !confirmedKeys.has(sig.key));
  let holdReason: string | null = null;
  if (projectClass === "commercial") {
    holdReason = `${COMMERCIAL_HOLD_LABEL}: a person set this job's class to commercial, so automation does not stage, replay, file, learn from or teach the shared knowledge with it.`;
  } else if (unconfirmed.length) {
    holdReason = `${PROBABLY_COMMERCIAL_LABEL}: ${unconfirmed.map((sig) => sig.message).join(" ")} Held for a person until someone confirms the job's class.`;
  }
  return { projectClass, confirmation, signals, unconfirmed, held: holdReason !== null, holdReason };
}
