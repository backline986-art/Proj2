// EACH STATE'S PERMIT RULES, AS CITED DATA (#595 PR2).
//
// The owner, 2026-11-04, on a real Oregon job returned as non-prescriptive: "It needs to have already
// known that code vs having us tell that to it." The job's racking was ballasted, which alone keeps an
// Oregon job off the prescriptive path, and nothing in the gate knew it.
//
// So each state's rules live in state_permit_rules (migration v63), one cited row per rule, in the
// shape #586 asks for its fee rules: family "structural" here, "fee" there, one table. Rows ship in
// backend/data/reference-state-permit-rules.json and land SEEDED; a row a person verified is never
// written again (rule 3). A state with nothing citable is simply absent: no rule, never a guess.
//
// What the reviewer does with them (statePrescriptiveFindings):
//   - a job whose path is PRESCRIPTIVE while a state rule sends it to the engineered path is REFUSED
//     (blocker), naming the reason and quoting the rule: ballasted / non-penetrating racking first,
//     then the limits the prescriptive screen routes on (snow, wind exposure, PV weight, framing
//     spacing) and a manufactured dwelling;
//   - an input such a rule needs that the plans do not state, and the rafter span where the state's
//     span limits are not on file, is "check with an engineer" (warning) — never a pass;
//   - on an engineered job the same reasons are named (callout), so the path says why.
// The BCD 5952 rows the prescriptive screen does not route on (attachment spacing, module height) stay
// the permit-path warning they are today: operator ruling pending (permitPath.ts, step 4).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeReference, ProjectRecord, ReviewerFinding, StatePermitRule } from "../../shared/src/types";
import type { AppDb } from "./db";
import { logger } from "./logger";
import { resolvePermitPath, usStateCode } from "./permitPath";
import { structureTypeForProject } from "./codeReviewRules";
import { mountKindForProject } from "./mountKind";
import { ballastedRackingEvidence } from "./ballastRacking";

type Row = Record<string, unknown>;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
function referencePath(): string {
  const explicit = (process.env.STATE_RULES_REFERENCE_PATH || "").trim();
  if (explicit) return path.resolve(explicit);
  // Read-only reference data shipped beside the code (never a state path: statePaths.ts owns those).
  return path.resolve(moduleDir, "..", "data", "reference-state-permit-rules.json");
}

export interface ReferenceRule {
  state: string;
  family: StatePermitRule["family"];
  key: string;
  value: unknown;
  citation: string;
  sourceUrl?: string;
  /** When the citation's words were read from `sourceUrl` (ISO date or time); '' = not recorded. */
  fetchedAt?: string;
}

/** THE ONE WRITE PATH into state_permit_rules, for the shipped reference and for research
 *  (stateFeeResearch.ts) alike. Rows always land SEEDED; a seeded row is refreshed (a corrected
 *  citation lands), a row a person verified is never touched (rule 3: the WHERE is in the statement,
 *  so no caller can skip it). A rule with no citation is refused, and a FEE rule — it changes an
 *  amount the quote charges — also needs the URL its words were read from (Helm's #637 bar).
 *  Returns 1 when a row was written, else 0. */
export function writeSeededStatePermitRule(db: AppDb, r: ReferenceRule, now = new Date().toISOString()): number {
  const state = usStateCode(r.state);
  if (!state || !r.key || !String(r.citation ?? "").trim() || (r.family !== "structural" && r.family !== "fee")) return 0;
  if (r.family === "fee" && !/^https?:\/\//i.test(String(r.sourceUrl ?? "").trim())) return 0;
  db.run(
    `INSERT INTO state_permit_rules (state, family, rule_key, value_json, citation, source_url, confidence, fetched_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'seeded', ?, ?)
     ON CONFLICT(state, family, rule_key) DO UPDATE SET
       value_json = excluded.value_json, citation = excluded.citation, source_url = excluded.source_url,
       confidence = 'seeded', fetched_at = excluded.fetched_at, updated_at = excluded.updated_at
     WHERE state_permit_rules.verified_at = ''
       AND (state_permit_rules.value_json != excluded.value_json OR state_permit_rules.citation != excluded.citation
            OR state_permit_rules.source_url != excluded.source_url OR state_permit_rules.confidence != 'seeded'
            OR state_permit_rules.fetched_at != excluded.fetched_at)`,
    [state, r.family, r.key, JSON.stringify(r.value ?? null), r.citation, r.sourceUrl ?? "", String(r.fetchedAt ?? "").trim().slice(0, 40), now],
  );
  return Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0);
}

/** Seed the shipped rules. Idempotent: a seeded row is refreshed from the reference (a corrected
 *  citation lands), a row a person verified is never touched (rule 3). Rules always land seeded. */
export function seedStatePermitRules(db: AppDb, filePath = referencePath()): number {
  if (!fs.existsSync(filePath)) return 0;
  const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { rules?: ReferenceRule[] };
  const now = new Date().toISOString();
  let written = 0;
  for (const r of data.rules ?? []) written += writeSeededStatePermitRule(db, r, now);
  if (written) logger.info("state-rules", `seeded ${written} state permit rule(s) from reference data`);
  return written;
}

/** One state's rules of one family (empty when the state has none on file). */
export function statePermitRulesFor(db: AppDb, state: string, family: StatePermitRule["family"] = "structural"): StatePermitRule[] {
  const code = usStateCode(state);
  if (!code) return [];
  return db.query<Row>(
    "SELECT state, family, rule_key, value_json, citation, source_url, confidence, verified_at FROM state_permit_rules WHERE state = ? AND family = ? ORDER BY rule_key",
    [code, family],
  ).map((row) => {
    let value: unknown = null;
    try { value = JSON.parse(String(row.value_json ?? "null")); } catch { value = null; }
    return {
      state: String(row.state), family, key: String(row.rule_key), value,
      citation: String(row.citation ?? ""), sourceUrl: String(row.source_url ?? ""),
      confidence: String(row.verified_at ?? "") ? "verified" : "seeded",
    };
  });
}

/** A rule as the reviewer's citation. */
export function ruleReference(rule: StatePermitRule): CodeReference {
  return {
    code: `${rule.state} state rule`,
    section: rule.key,
    title: rule.citation,
    adoptionScope: `${rule.state} (statewide)`,
    sourceUrl: rule.sourceUrl,
    note: rule.confidence === "verified" ? "Verified against the official source." : "Seeded from the cited source; verify locally.",
  };
}

// BALLASTED / NON-PENETRATING RACKING: the one predicate lives in ballastRacking.ts (a leaf), so the
// reviewer's attachment rule (codeReviewRules, which this module imports) reads the same answer.
export { ballastedRackingEvidence } from "./ballastRacking";

function numberOf(project: ProjectRecord, key: string): number | null {
  const raw = String((project.parserSnapshot || {})[key] ?? "").replace(/[^0-9.\-]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function textOf(project: ProjectRecord, key: string): string {
  return String((project.parserSnapshot || {})[key] ?? "").trim();
}

interface Reason { why: string; rule: StatePermitRule }

/**
 * The reviewer findings a state's structural rules raise for this job. Pure: the rules come from
 * statePermitRulesFor (repository.reviewerGateReportFor). Rooftop jobs in a state that publishes a
 * prescriptive path only; a state with no rules on file raises nothing.
 */
export function statePrescriptiveFindings(project: ProjectRecord, rules: StatePermitRule[]): ReviewerFinding[] {
  const rule = (key: string) => rules.find((r) => r.key === key);
  const pathRule = rule("prescriptivePath");
  if (!pathRule || (pathRule.value as { available?: boolean } | null)?.available !== true) return [];
  const mount = mountKindForProject(project);
  if (mount === "ground" || mount === "carport") return [];
  const state = rules[0].state;
  const resolved = resolvePermitPath(project).path;
  if (resolved === "unknown") return [];

  // WHAT SENDS THIS JOB TO THE ENGINEERED PATH, by the state's own rules.
  const forcing: Reason[] = [];
  const unread: Reason[] = [];
  const attachment = rule("attachmentMethods");
  if (attachment) {
    const ballast = ballastedRackingEvidence(project);
    if (ballast) forcing.push({ why: `ballasted / non-penetrating racking (${ballast}) is attached by none of the state's prescriptive methods`, rule: attachment });
    else if (!textOf(project, "rackingSystem") && !textOf(project, "attachmentHardware") && !/^y/i.test(textOf(project, "attachmentToFraming"))) {
      unread.push({ why: "the plans do not name the racking or how it attaches to the roof", rule: attachment });
    }
  }
  const limit = (key: string, field: string, label: string, unit: string) => {
    const r = rule(key);
    const max = typeof r?.value === "number" ? r.value : null;
    if (!r || max == null) return;
    const v = numberOf(project, field);
    if (v == null) unread.push({ why: `the plans do not state the ${label}`, rule: r });
    else if (v > max) forcing.push({ why: `${label} ${v} ${unit} is over the ${max} ${unit} prescriptive limit`, rule: r });
  };
  limit("maxGroundSnowPsf", "snow", "ground snow load", "psf");
  limit("maxPvSystemWeightPsf", "deadLoad", "PV system weight", "psf");
  limit("maxFramingSpacingIn", "roofRafterSpacing", "rafter / truss spacing", "in o.c.");
  const exposures = rule("allowedWindExposures");
  if (exposures && Array.isArray(exposures.value)) {
    const wind = textOf(project, "wind").toUpperCase();
    const letter = /\b([BCD])\b/.exec(wind)?.[1] ?? "";
    if (!letter) unread.push({ why: "the plans do not state the wind exposure category", rule: exposures });
    else if (!(exposures.value as string[]).includes(letter)) forcing.push({ why: `wind exposure ${letter} is outside the allowed ${(exposures.value as string[]).join(" / ")}`, rule: exposures });
  }
  const prescriptiveRule = pathRule;
  if (structureTypeForProject(project).kind === "manufactured_home") forcing.push({ why: "the supporting structure is a manufactured dwelling", rule: prescriptiveRule });
  // THE RAFTER SPAN. Where the state's span limits are on file they would be read here; where they
  // are not (Oregon's live in ORSC R324.4.1 Exception 1.4-1.6), a rafter roof is a check with an
  // engineer unless a person answered the exception row Yes.
  const spanRule = rule("rafterSpanRule");
  const framing = textOf(project, "framingType").toLowerCase();
  if (spanRule && /rafter/.test(framing) && !/truss/.test(framing) && !/^y/i.test(textOf(project, "rafterExceptionCompliant"))) {
    const span = numberOf(project, "roofRafterSpan");
    const ref = (spanRule.value as { reference?: string } | null)?.reference || "the state's rafter span rule";
    unread.push({ why: `${span != null ? `rafter span ${span} ft read from the plans` : "the plans do not state the rafter span"}; the span limits (${ref}) are not on file here`, rule: spanRule });
  }

  const out: ReviewerFinding[] = [];
  const refs = (rs: Reason[]) => [...new Map(rs.map((r) => [r.rule.key, ruleReference(r.rule)])).values()];
  const list = (rs: Reason[]) => rs.map((r) => `${r.why} — ${r.rule.citation}`).join(" ");
  if (forcing.length && resolved === "prescriptive") {
    out.push({
      id: "state.struct.prescriptive-refused",
      severity: "blocker",
      category: "structural",
      title: `Prescriptive filing refused: ${forcing.map((r) => r.why.split(" (")[0]).join("; ")} → engineered`,
      message: `This job is on the prescriptive path, but ${state}'s rules send it to the engineered path: ${list(forcing)}`,
      cityFeedback: "The design does not qualify for the prescriptive path; submit the engineered (structural) application with stamped structural calculations.",
      designTeamAction: "Set the permit path to engineered (Manual entry → Permit path) and collect the stamped structural letter / calculations from the engineer of record.",
      evidenceNeeded: ["Engineered (structural) application", "Stamped structural calculations or engineer's letter"],
      codeReferences: refs(forcing),
      installerCallout: true,
    });
  } else if (forcing.length) {
    out.push({
      id: "state.struct.engineered-reasons",
      severity: "callout",
      category: "structural",
      title: `Engineered path: ${forcing.map((r) => r.why.split(" (")[0]).join("; ")}`,
      message: `${state}'s rules send this job to the engineered path: ${list(forcing)}`,
      cityFeedback: "File the engineered (structural) application with stamped structural calculations.",
      designTeamAction: "Keep the engineered path; the stamped structural package is required.",
      evidenceNeeded: [],
      codeReferences: refs(forcing),
      installerCallout: true,
    });
  }
  if (unread.length && resolved === "prescriptive") {
    out.push({
      id: "state.struct.prescriptive-unverified",
      severity: "warning",
      category: "structural",
      title: "Check with an engineer: prescriptive limits not confirmed from the plans",
      message: `The prescriptive path cannot be confirmed against ${state}'s rules: ${list(unread)}`,
      cityFeedback: "Show the structural inputs the prescriptive checklist asks for, or provide stamped engineering.",
      designTeamAction: "Get the missing values onto the plans, or have an engineer confirm the design (or stamp it and file engineered).",
      evidenceNeeded: unread.map((r) => r.why),
      codeReferences: refs(unread),
      installerCallout: true,
    });
  }
  return out;
}

/** The out-of-state seal finding (codeReviewRules, #595 PR1) cites the job state's own seal rule
 *  where one is on file, in place of the generic reference. Mutates the findings. */
export function citeStateSealRule(findings: ReviewerFinding[], rules: StatePermitRule[]): void {
  const seal = rules.find((r) => r.key === "sealStateOnly");
  if (!seal) return;
  for (const f of findings) {
    if (f.id === "city.struct.seal-out-of-state") f.codeReferences = [ruleReference(seal)];
  }
}
