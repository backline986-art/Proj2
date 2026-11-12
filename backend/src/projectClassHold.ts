// ---------------------------------------------------------------------------
// THE CLASS HOLD, READ FROM THE DATABASE (#688). shared/src/projectClass.ts decides; this module
// only loads a project row into it, so every door (staging, replay, the correction reopen, the
// learn door, the shared-knowledge writers, the track cards, the next step) asks ONE predicate.
//
// READS ONLY. Nothing here writes — the next-step and track-card readers call it, and they pin
// "reads write nothing". It imports no repository / knowledgeBase export, so either may import it
// without a cycle.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { AuthorityEligibilityRecord, ParserPayload, ProjectClassStatus, ResidentialCapCitation } from "../../shared/src/types";
import { eligibilityRecordsForState, normalizeAuthorityName } from "./eligibilityLimits";
import { parseProjectClassConfirmation, projectClassStatus } from "../../shared/src/projectClass";

type Row = Record<string, unknown>;

/**
 * THE RESIDENTIAL CAPS ON FILE FOR THIS JOB, from cited per-authority data: #679's eligibility
 * records (authority_eligibility_limits + the shipped reference rows) for the job's state, the
 * utility-PROGRAM records that match its utility (or name every utility in the state), each limit
 * with its source name, URL and verbatim words. A program whose own name / scope names ONLY a
 * non-residential class is not a residential cap and is skipped. With none on file the screen uses
 * the one strict default (25 kW, a warning that holds) — never a looser path.
 */
export function residentialCapsFor(db: AppDb, project: { state: string; utility: string }): ResidentialCapCitation[] {
  let records: AuthorityEligibilityRecord[] = [];
  try { records = eligibilityRecordsForState(db, project.state); } catch { records = []; }
  const utility = normalizeAuthorityName(project.utility);
  const out: ResidentialCapCitation[] = [];
  for (const rec of records) {
    if (rec.authorityKind !== "utility_program") continue;
    if (rec.authority && (!utility || normalizeAuthorityName(rec.authority) !== utility)) continue;
    for (const [basis, limit] of [["dc", rec.limits.maxDcKw], ["ac", rec.limits.maxAcKw]] as const) {
      if (!limit || !Number.isFinite(Number(limit.value)) || Number(limit.value) <= 0) continue;
      const scope = `${rec.programName} ${limit.appliesOnlyTo ?? ""}`;
      if (NON_RESIDENTIAL.test(scope) && !/\bresidential\b/i.test(scope.replace(new RegExp(NON_RESIDENTIAL.source, "gi"), " "))) continue;
      out.push({
        basis,
        valueKw: Number(limit.value),
        sourceName: limit.citation?.sourceName ?? "",
        sourceUrl: limit.citation?.sourceUrl ?? "",
        quote: limit.citation?.quote ?? "",
      });
    }
  }
  return out;
}
const NON_RESIDENTIAL = /\b(?:non[- ]?residential|commercial|industrial|agricultur\w*)\b/i;

function parseSnapshot(raw: unknown): ParserPayload {
  if (typeof raw !== "string" || !raw.trim()) return {} as ParserPayload;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ParserPayload) : ({} as ParserPayload);
  } catch {
    return {} as ParserPayload;
  }
}
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The class status of a stored project row, or null when no such project exists. */
export function projectClassStatusForRow(db: AppDb, row: Row): ProjectClassStatus {
  return projectClassStatus({
    projectClass: String(row.project_class ?? "") === "commercial" ? "commercial" : "residential",
    projectClassConfirmation: parseProjectClassConfirmation(row.project_class_confirmation),
    systemSizeDcKw: numOrNull(row.system_size_dc_kw),
    systemSizeAcKw: numOrNull(row.system_size_ac_kw),
    parserSnapshot: parseSnapshot(row.parser_json),
  }, residentialCapsFor(db, { state: String(row.state ?? ""), utility: String(row.utility ?? "") }));
}

export function projectClassStatusFor(db: AppDb, projectId: string | null | undefined): ProjectClassStatus | null {
  if (!projectId) return null;
  const row = db.get<Row>(
    `SELECT state, utility, system_size_dc_kw, system_size_ac_kw, parser_json, project_class, project_class_confirmation
       FROM projects WHERE id = ?`,
    [projectId],
  );
  return row ? projectClassStatusForRow(db, row) : null;
}

/** WHY AUTOMATION MUST LEAVE THIS JOB TO A PERSON, or null when it need not. The one question every
 *  door asks; an unknown project answers null (the door's own 404 speaks for it). */
export function projectClassHoldReason(db: AppDb, projectId: string | null | undefined): string | null {
  return projectClassStatusFor(db, projectId)?.holdReason ?? null;
}
