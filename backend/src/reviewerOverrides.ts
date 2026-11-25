// ---------------------------------------------------------------------------
// A NAMED PERSON PUSHES PAST ONE REVIEWER BLOCKER, WITH A REASON (#640; owner request 2026-11-09).
//
// The reviewer gate's defaults stay strict. This is the escape hatch: on ONE project, a named,
// signed-in staff member (with sign-in off: the typed name, placeholders refused) records why a
// blocker should not hold the filing. Owner rulings, binding:
//
//   1. Any reviewer blocker may be overridden EXCEPT city.struct.stamped-engineering-missing (and its
//      tile twin, released by the same door), which keeps its own door (POST
//      /api/projects/:id/structural-letter/confirm, #198). Refused with 409 naming that door, and
//      refused again inside the fold (belt and braces).
//   2. An override counts at EVERY door exactly like a cached vision verdict (#214): it is folded in
//      by repository.reviewerGateReportFor and nowhere else (reviewerSeverityParity.test.ts pins
//      that on the syntax tree), so the gate, the correction notice, staging, Approve / next-step,
//      the re-judges and the printable packet all read the same answer. One recorded AFTER an
//      "Approve & auto-submit" click does not let that run file (#226): prepareSubmission compares
//      against the overrides the approval recorded as in force, and automaticSubmitRefusals names it.
//   3. WHO comes from the session when sign-in is on, never the request body (server.ts,
//      reviewerOverridePerson). A non-empty reason is required.
//
// WHAT AN OVERRIDE COVERS. Exactly the finding the person looked at, as it stood:
//   - finding_id: one finding. It never releases a different one, and it releases that finding only
//     in the tracks it already held (gateScope.findingHoldScope): relaxing a permit-only finding to a
//     callout cannot touch an NEM hold, which is another finding.
//   - fingerprint: a hash of the finding's plan-derived content (findingFingerprint, below).
//   - plan_set_sig: the plan set as the vision cache identifies it (reviewerVision.planSetIdentity).
// When the live finding no longer matches either, the override does not apply: the blocker blocks
// again, and the finding carries overrideVoided with the reason so the dashboard can say why.
// Validity is computed on READ and nothing is stamped there (reads write nothing, nextStep.test).
// A matching finding coming back (a field edited back) is the very thing the person looked at, so its
// override stands again. That revival can never carry a final submit past an APPROVER who saw the
// blocker: the approval records which overrides were releasing a blocker at the click
// (releasedOverrides → portal_run_approvals.released_overrides_json), and prepareSubmission lets a
// run file past an override only when that override was on its approval's list.
// The page binds too: every overridable blocker carries overrideSeenAs (seenAsToken), the dashboard
// echoes it, and the writer refuses 409 when the finding or plan set moved between page and click.
//
// The finding stays visible: severity "callout", overriddenFrom "blocker", override {by, at, reason},
// and its designTeamAction opens with "Overridden by <name> on <date>: <reason>".
//
// This module must not import ./repository statically: repository imports the fold from here. The
// writer reads the gate through a dynamic import.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import type { AppDb } from "./db";
import type { ReviewerBlockerOverrideView, ReviewerFinding, ReviewerReport } from "../../shared/src/types";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";
import { planSetIdentity } from "./reviewerVision";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));

export const REVIEWER_BLOCKER_OVERRIDDEN_ACTION = "reviewer_gate.blocker_overridden";
export const REVIEWER_BLOCKER_OVERRIDE_WITHDRAWN_ACTION = "reviewer_gate.blocker_override_withdrawn";
export const REVIEWER_OVERRIDE_RELAXED_AT_STAGE_ACTION = "reviewer_gate.override_relaxed_at_stage";

/** Findings no override may release, each with the door that does (owner ruling 1). The tile twin
 *  (codeReviewRules: the same stamped-structural hold raised on the tile-roof path) is released by the
 *  very same structural-letter confirmation, so it keeps that door too (owner, 2026-11-09 on #640:
 *  "keep it non-overridable"; a tile job that truly owes no engineering is a permit-path fix). */
const STRUCTURAL_LETTER_DOOR =
  "The stamped-structural hold keeps its own door: a named person confirms the engineer's sealed letter (POST /api/projects/:id/structural-letter/confirm, the structural-letter card on the submit gate). It cannot be overridden.";
export const NOT_OVERRIDABLE: ReadonlyMap<string, string> = new Map([
  ["city.struct.stamped-engineering-missing", STRUCTURAL_LETTER_DOOR],
  ["city.struct.tile-stamped-engineering-missing", STRUCTURAL_LETTER_DOOR],
]);

// WHICH FIELDS BIND AN OVERRIDE (the fingerprint). The danger is a FALSE MATCH (an override standing
// over a finding that now says something else); a false void only makes the blocker block again,
// which is the safe direction. So the plan-derived content goes in, and only what is known to be
// provenance or a later fold's rewrite stays out:
//   IN   id, category, title, message (the computed values live there: dc-size-mismatch's
//        "calculates 8.60 kW DC but project DC size is 10.00 kW" is ONLY in the message),
//        evidenceNeeded, and each evidence item's kind / label / excerpt / pageHint (what the plan
//        set and the project fields say).
//   OUT  designTeamAction (vision prefixes it, this fold rewrites it), evidenceStatus and
//        visionVerification (written by the vision fold), severity (it must be "blocker" to be
//        released at all), cityFeedback (the AHJ-voice boilerplate; the message carries the values),
//        codeReferences (code editions and their research/verification provenance, not the plan),
//        evidence note / source / confidence / verifier / screenshotPath, process_profile and
//        screenshot_placeholder evidence (profile provenance and a crop slot), and this module's own
//        override / overrideVoided annotations.
// Inside the kept text, provenance phrases are removed before hashing: designCriteria's rowProvenance
// "(human-verified by X on 2026-10-01 …)" / "(seeded 2026-10-01 — …)" / "(verified via the shipped
// reference seed …)" parentheticals, and ISO dates, so re-verifying a code profile does not void an
// override of a plan-set finding.
const PROVENANCE_PARENS = /\((?:human-verified|seeded|verified via)[^)]*\)/gi;
const ISO_DATES = /\b\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z?)?\b/g;
const norm = (v: unknown): string => s(v).replace(PROVENANCE_PARENS, "").replace(ISO_DATES, "").replace(/\s+/g, " ").trim();
const UNBOUND_EVIDENCE_KINDS = new Set(["process_profile", "screenshot_placeholder"]);

export function findingFingerprint(finding: ReviewerFinding): string {
  const content = [
    finding.id,
    finding.category,
    norm(finding.title),
    norm(finding.message),
    (finding.evidenceNeeded || []).map(norm),
    (finding.evidenceFound || [])
      .filter((e) => !UNBOUND_EVIDENCE_KINDS.has(e.kind))
      .map((e) => [e.kind, norm(e.label), norm(e.excerpt), norm(e.pageHint)]),
  ];
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32);
}

/** WHAT THE PERSON LOOKED AT, AS ONE TOKEN: the finding's fingerprint and the plan set's identity,
 *  hashed (the identity carries a server path; it never leaves the server raw). The fold puts it on
 *  every blocker a person may override (overrideSeenAs); the dashboard echoes it with the override,
 *  and the writer refuses when it no longer matches, so a plan set or a field edit that lands between
 *  the page and the click can never be what the override binds to. */
export function seenAsToken(fingerprint: string, planSetSig: string): string {
  return crypto.createHash("sha256").update(`${fingerprint}\n${planSetSig}`).digest("hex").slice(0, 32);
}

interface OverrideRow {
  id: string;
  finding_id: string;
  fingerprint: string;
  plan_set_sig: string;
  reason: string;
  overridden_by: string;
  created_at: string;
}

const viewOf = (r: OverrideRow): ReviewerBlockerOverrideView => ({ id: r.id, by: r.overridden_by, at: r.created_at, reason: r.reason });

/** The standing override per finding id (the newest; a newer one supersedes, so there is one).
 *  recordedBefore: only overrides recorded before that instant (the gate as an approver saw it). */
function standingOverrides(db: AppDb, projectId: string, recordedBefore?: string): Map<string, OverrideRow> {
  const rows = db.query<Row>(
    `SELECT id, finding_id, fingerprint, plan_set_sig, reason, overridden_by, created_at FROM reviewer_blocker_overrides
      WHERE project_id = ? AND withdrawn_at = ''${recordedBefore === undefined ? "" : " AND created_at < ?"}
      ORDER BY created_at DESC, rowid DESC`,
    recordedBefore === undefined ? [projectId] : [projectId, recordedBefore],
  );
  const out = new Map<string, OverrideRow>();
  for (const r of rows) {
    const fid = s(r.finding_id);
    if (out.has(fid)) continue;
    out.set(fid, {
      id: s(r.id), finding_id: fid, fingerprint: s(r.fingerprint), plan_set_sig: s(r.plan_set_sig),
      reason: s(r.reason), overridden_by: s(r.overridden_by), created_at: s(r.created_at),
    });
  }
  return out;
}

/** "Overridden by Jane Example on 2026-11-09: <reason>" — the line the gate, the notice and the packet show. */
export function overrideLine(o: Pick<ReviewerBlockerOverrideView, "by" | "at" | "reason">): string {
  return `Overridden by ${o.by} on ${o.at.slice(0, 10)}: ${o.reason}`;
}

/**
 * THE FOLD. Called ONLY by repository.reviewerGateReportFor, after the cached vision verdicts
 * (reviewerSeverityParity.test.ts fails on any other production caller). Reads
 * reviewer_blocker_overrides; writes nothing. A finding is released only while it is a BLOCKER at
 * this point (vision found nothing to relax), its standing override was recorded for this plan set
 * and hashes to the same content, and it is not in NOT_OVERRIDABLE.
 */
export function applyReviewerBlockerOverrides(db: AppDb, report: ReviewerReport, opts: { recordedBefore?: string } = {}): ReviewerReport {
  // A blocker no override may release carries the door that does (overrideRefusal): the dashboard
  // reads it rather than keeping its own list, so the two can never disagree.
  const refused = (finding: ReviewerFinding): ReviewerFinding => ({ ...finding, overrideRefusal: NOT_OVERRIDABLE.get(finding.id) });
  if (!report.findings.some((finding) => finding.severity === "blocker" && !NOT_OVERRIDABLE.has(finding.id))) {
    if (!report.findings.some((finding) => finding.severity === "blocker" && NOT_OVERRIDABLE.has(finding.id))) return report;
    const findings = report.findings.map((finding) => (finding.severity === "blocker" && NOT_OVERRIDABLE.has(finding.id) ? refused(finding) : finding));
    return { ...report, findings, installerCallouts: findings.filter((item) => item.installerCallout) };
  }
  const standing = standingOverrides(db, report.projectId, opts.recordedBefore);
  let planSet: string | null = null;
  const currentPlanSet = (): string => (planSet ??= planSetIdentity(db, report.projectId));
  // A blocker that still blocks carries the token of what the gate shows now (seenAsToken).
  const stillBlocking = (finding: ReviewerFinding, fingerprint: string, extra: Partial<ReviewerFinding> = {}): ReviewerFinding =>
    ({ ...finding, ...extra, overrideSeenAs: seenAsToken(fingerprint, currentPlanSet()) });
  const findings = report.findings.map((finding): ReviewerFinding => {
    if (finding.severity !== "blocker") return finding;
    if (NOT_OVERRIDABLE.has(finding.id)) return refused(finding);
    const fingerprint = findingFingerprint(finding);
    const row = standing.get(finding.id);
    if (!row) return stillBlocking(finding, fingerprint);
    const view = viewOf(row);
    if (row.plan_set_sig !== currentPlanSet()) {
      return stillBlocking(finding, fingerprint, { overrideVoided: { ...view, why: "the plan set was replaced since the override was recorded — look again and override again if it still should not hold" } });
    }
    if (row.fingerprint !== fingerprint) {
      return stillBlocking(finding, fingerprint, { overrideVoided: { ...view, why: "this finding changed since the override was recorded (the project or plan values it reads are different) — look again and override again if it still should not hold" } });
    }
    return {
      ...finding,
      severity: "callout",
      overriddenFrom: "blocker",
      override: view,
      designTeamAction: `${overrideLine(view)}. ${finding.designTeamAction}`.trim(),
    };
  });
  return { ...report, findings, installerCallouts: findings.filter((item) => item.installerCallout) };
}

/** The findings in a gate report that are no longer blockers only because a person overrode them.
 *  What staging and Approve audit when they proceed past one, and what #226 compares as of an approval. */
export function overriddenBlockers(report: ReviewerReport): ReviewerFinding[] {
  return report.findings.filter((finding) => finding.overriddenFrom === "blocker");
}

/** One override that was releasing a blocker when an approval was minted. */
export interface ReleasedOverride { overrideId: string; findingId: string }

/** WHAT AN APPROVER SAW RELEASED (#226). The overrides releasing a blocker in this gate read —
 *  repository.createRunApproval stores them on the approval at the click. An override's validity is
 *  computed against the CURRENT finding, so the gate rebuilt later "as of the approval" cannot say
 *  whether an override was in force then (one void at the click applies again after a field is edited
 *  back); this list can. prepareSubmission lets a final-submit run past an override only when that
 *  override's id is in it. */
export function releasedOverrides(report: ReviewerReport): ReleasedOverride[] {
  return overriddenBlockers(report)
    .filter((finding) => finding.override?.id)
    .map((finding) => ({ overrideId: finding.override!.id, findingId: finding.id }));
}

/** Any standing (unwithdrawn) override on this project? The approval reads the gate only then. */
export function hasStandingOverride(db: AppDb, projectId: string): boolean {
  return Boolean(db.get("SELECT 1 FROM reviewer_blocker_overrides WHERE project_id = ? AND withdrawn_at = '' LIMIT 1", [projectId]));
}

/** portal_run_approvals.released_overrides_json → the list; anything unreadable is nothing released
 *  (the safe direction: every override-relaxed blocker then stops that run at review). */
export function parseReleasedOverrides(json: unknown): ReleasedOverride[] {
  try {
    const parsed = JSON.parse(s(json) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
      .map((r) => ({ overrideId: s(r.overrideId), findingId: s(r.findingId) }))
      .filter((r) => r.overrideId && r.findingId);
  } catch {
    return [];
  }
}

/** The audit row for a gate that let a filing through on an override: staging (prepareSubmission)
 *  or Approve (runAutopilotApproval) went past a blocker only an override released. Nothing
 *  overridden → no row. recordedAfterApproval: the finding ids whose override a claimed approval did not see in force
 *  (#226): recorded after the click, or void at it. */
export function auditOverrideRelaxedAtStage(
  db: AppDb, projectId: string,
  input: { via: "stage" | "approve"; runId: string; track: string | null; overridden: ReviewerFinding[]; recordedAfterApproval?: string[] },
): void {
  if (input.overridden.length === 0) return;
  addAuditLog(db, projectId, "system", "reviewer gate", REVIEWER_OVERRIDE_RELAXED_AT_STAGE_ACTION, {
    via: input.via, runId: input.runId, track: input.track,
    findings: input.overridden.map((f) => ({
      findingId: f.id, overrideId: f.override?.id ?? null, by: f.override?.by ?? null, at: f.override?.at ?? null, reason: f.override?.reason ?? null,
    })),
    ...(input.recordedAfterApproval ? { recordedAfterApproval: input.recordedAfterApproval } : {}),
  });
}

const oneLine = (v: unknown): string => s(v).replace(/\s+/g, " ").trim();
const MAX_REASON = 2000;

/**
 * OVERRIDE: the production writer (the route resolves WHO; this records it). The finding must be a
 * BLOCKER on this project's gate as it stands right now (cached vision verdicts folded in, no
 * standing override releasing it), else 409. Supersedes any earlier standing override of the same
 * finding (a voided one is the usual case). One audit row.
 */
export async function overrideReviewerBlocker(
  db: AppDb,
  projectId: string,
  findingId: string,
  input: { reason: string; by: string; userId?: string; seenAs?: string },
): Promise<{ override: ReviewerBlockerOverrideView; findingId: string }> {
  const who = oneLine(input.by);
  if (!who) throw new HttpError(400, "A named person must override a reviewer blocker.");
  const fid = oneLine(findingId);
  const door = NOT_OVERRIDABLE.get(fid);
  if (door) throw new HttpError(409, door, { notOverridable: true, findingId: fid, door: `/api/projects/${projectId}/structural-letter/confirm` });
  const reason = oneLine(input.reason).slice(0, MAX_REASON);
  if (!reason) throw new HttpError(400, "Say why this blocker should not hold the filing — a reason is required.");
  const { getProjectDetail, reviewerGateReportFor } = await import("./repository");
  const { project } = getProjectDetail(db, projectId);
  const report = reviewerGateReportFor(db, project);
  const finding = report.findings.find((f) => f.id === fid);
  if (!finding) throw new HttpError(409, `${fid || "That finding"} is not on this project's reviewer gate now.`, { findingId: fid });
  if (finding.overriddenFrom === "blocker" && finding.override) {
    throw new HttpError(409, `This blocker is already overridden (${overrideLine(finding.override)}). Withdraw that override first.`, { findingId: fid });
  }
  if (finding.severity !== "blocker") {
    throw new HttpError(409, `"${finding.title}" is not a blocker on this project's gate now (it reads as ${finding.severity}); only a blocker can be overridden.`, { findingId: fid, severity: finding.severity });
  }
  const fingerprint = findingFingerprint(finding);
  const planSetSig = planSetIdentity(db, project.id);
  // BOUND TO WHAT THE PERSON LOOKED AT: the token the page showed (overrideSeenAs) must still describe
  // this finding on this plan set. The route always passes it (so it is required there: "" → 400); a
  // direct caller that passes none (undefined) binds to the gate as read here.
  if (input.seenAs !== undefined) {
    const seenAs = s(input.seenAs).trim();
    if (!seenAs) throw new HttpError(400, "Reload the reviewer gate and override from the blocker you are looking at (seenAs is required).", { findingId: fid });
    if (seenAs !== seenAsToken(fingerprint, planSetSig)) {
      throw new HttpError(409, `"${finding.title}" changed since you looked at it (a new plan set, or a project or plan value it reads). Reload the reviewer gate, look again, and override again if it still should not hold.`, { findingId: fid, stale: true });
    }
  }
  const at = nowIso();
  const overrideId = id();
  const userId = s(input.userId);
  db.transaction(() => {
    const superseded = standingOverrides(db, project.id).get(fid);
    db.run(
      "UPDATE reviewer_blocker_overrides SET withdrawn_by = ?, withdrawn_by_user_id = ?, withdrawn_at = ? WHERE project_id = ? AND finding_id = ? AND withdrawn_at = ''",
      [`superseded by ${who}`, userId, at, project.id, fid],
    );
    db.run(
      `INSERT INTO reviewer_blocker_overrides
        (id, project_id, finding_id, fingerprint, plan_set_sig, reason, overridden_by, overridden_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [overrideId, project.id, fid, fingerprint, planSetSig, reason, who, userId, at],
    );
    // The user id is there because a display name is editable.
    addAuditLog(db, project.id, "human", who, REVIEWER_BLOCKER_OVERRIDDEN_ACTION, {
      overrideId, findingId: fid, title: finding.title, reason, fingerprint, planSetSig, overriddenAt: at, userId,
      ...(superseded ? { supersededOverrideId: superseded.id } : {}),
    });
  });
  return { override: { id: overrideId, by: who, at, reason }, findingId: fid };
}

/** WITHDRAW the standing override of one finding (a voided one too: it still stands in the table
 *  until withdrawn or superseded). 409 when there is none. The blocker holds again on the next read. */
export function withdrawReviewerBlockerOverride(
  db: AppDb, projectId: string, findingId: string, withdrawnBy: string, userId = "",
): { withdrawn: true; overrideId: string; findingId: string } {
  const who = oneLine(withdrawnBy);
  if (!who) throw new HttpError(400, "A named person must withdraw a blocker override.");
  const fid = oneLine(findingId);
  const row = standingOverrides(db, projectId).get(fid);
  if (!row) throw new HttpError(409, "No standing override of this blocker to withdraw.", { findingId: fid });
  const at = nowIso();
  db.transaction(() => {
    db.run(
      "UPDATE reviewer_blocker_overrides SET withdrawn_by = ?, withdrawn_by_user_id = ?, withdrawn_at = ? WHERE project_id = ? AND finding_id = ? AND withdrawn_at = ''",
      [who, s(userId), at, projectId, fid],
    );
    addAuditLog(db, projectId, "human", who, REVIEWER_BLOCKER_OVERRIDE_WITHDRAWN_ACTION, {
      overrideId: row.id, findingId: fid, withdrawnAt: at, userId: s(userId),
    });
  });
  return { withdrawn: true, overrideId: row.id, findingId: fid };
}
