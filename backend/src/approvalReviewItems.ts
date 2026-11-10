// THE OPEN REVIEW ITEMS OF ONE FILING, AND WHO ACKNOWLEDGED THE MEASURED ONES (review-audit draft 01).
//
// Only reviewer BLOCKERS held Stage or Approve. A plan whose own one-line breaks the 705.12 busbar
// allowance (200 A bus, 200 A main, 60 A PV = 260 A > 240 A) reads city.elec.sizing-busbar-120 as a
// WARNING when its inputs came from the parser — by design, a parser read never blocks — and the
// approval sheet, the one screen a person reads before Approve & auto-submit, showed no warning at
// all. An automatic filing could carry a violation the AHJ will correct, and nobody saw it. With
// auto-submit the approval IS the human final-submit gate the form-mapping check names.
//
// So, per filing:
//   · EVERY open item is listed on the sheet: each reviewer warning and each submit-gate warning
//     check whose scope holds THIS track (gateScope.scopeHoldsTrack — the one predicate the gate,
//     Stage and Approve read; a finding's scope is findingHoldScope, a check's gateWarningScope),
//     and each unverified AHJ form mapping on a form this track files.
//   · A MEASURED item — a finding in reviewerVision.MEASURED_FINDING_IDS (arithmetic against the
//     plan's own numbers) — and an unverified form mapping must be ACKNOWLEDGED, one tick each,
//     before Approve enables. The acknowledgement is bound like the structural-letter confirmation
//     (#198): the approver (from the approval), each item's id and content hash, and the shipped plan
//     set's document id + sha256.
//   · At the run, the items needing one are read again: an item that is new, changed (another hash)
//     or not acknowledged, or a plan set replaced since the approval, makes the run stop at review
//     (repository.automaticSubmitRefusals / the email door's finalSubmitRefusals). Never a click on
//     an unacknowledged measured violation.
//
// IT ONLY ADDS A STOP. Nothing here relaxes a blocker or a gate: the reviewer gate, the submit gate
// and the final-submit gate decide exactly what they decided before. Plain Stage (no approval) is
// unchanged — it stops at the portal's review screen anyway.
//
// A LEAF MODULE: repository (the run, the gate's form check), approvalSheet (the sheet) and the
// approve route import it; it imports none of them (repository's reviewer report is passed in).
import crypto from "node:crypto";
import type {
  ApprovalAcknowledgements, ApprovalPlanSetBinding, ApprovalSheetOpenItem, ProjectRecord, ReviewerFinding,
  SubmitGateCheck, SubmittalTrackType,
} from "../../shared/src/types";
import type { AppDb } from "./db";
import { formAllowedForPath, loadStoredTemplates, type StoredTemplate } from "./ahjForms";
import { formTrackForSubmittalTrack } from "./applicationDocsAgency";
import { resolvePermitPathForProject } from "./codeProfiles";
import { findingHoldScope, gateWarningScope, scopeHoldsTrack } from "./gateScope";
import { shippedPlanSet } from "./projectDocuments";
import { MEASURED_FINDING_IDS } from "./reviewerVision";
import { fileSha256 } from "./structuralLetterVoid";

const s = (v: unknown): string => (v == null ? "" : String(v).trim());
const sha = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * THE AHJ FORMS WHOSE MAPPING NO PERSON HAS VERIFIED — the submit gate's own list (its
 * `ahj-form-mapping-verified` check reads this function), so the sheet and the gate cannot disagree.
 * Only forms filled for this project's permit path (the other application is skipped), and never a
 * form filled from a built-in map written for its exact blank (it was never derived automatically).
 * The STORED kind is read, exactly as the fill gate reads it.
 */
export function unverifiedFormMappings(db: AppDb, project: ProjectRecord): StoredTemplate[] {
  const path = resolvePermitPathForProject(db, project).path;
  return loadStoredTemplates(db, project.ahj, project.state)
    .filter((t) => !t.verified && !t.builtInMap && formAllowedForPath(t.def.formName, path, t.applicationKind));
}

/** Does a filing of `track` carry this form? Never the utility filing (AHJ forms are the permit's).
 *  A form of the OTHER discipline is not this permit's (the electrical permit does not file the
 *  building application); a combination permit files both; a form with no discipline (a state
 *  checklist, the generic application) rides every permit. Unknown → carried (an unknown never
 *  clears); a null track (a trackless stage) files everything. */
export function formFiledOnTrack(t: Pick<StoredTemplate, "def">, track: SubmittalTrackType | null): boolean {
  if (track === null) return true;
  if (track === "nem") return false;
  if (track === "combo" || track === "permit") return true;
  const formTrack = s(t.def.formTrack);
  if (formTrack !== "building" && formTrack !== "electrical") return true;
  return formTrack === formTrackForSubmittalTrack(track);
}

/** A finding's content hash: what the approver read. A changed number in the title or the AHJ's
 *  sentence is a different finding to acknowledge. */
export function findingContentHash(f: Pick<ReviewerFinding, "id" | "severity" | "title" | "message" | "cityFeedback">): string {
  return sha(["finding", s(f.id), s(f.severity), s(f.title), s(f.message), s(f.cityFeedback)]);
}

/** A form mapping's content hash: the stored row, its blank and every placement the fill uses. A
 *  re-derived map is a different mapping to acknowledge. */
export function formMappingContentHash(t: StoredTemplate): string {
  const d = t.def;
  return sha(["form", t.templateId, t.sourceHash || crypto.createHash("sha256").update(t.bytes).digest("hex"),
    d.formName, d.textFields ?? {}, d.checkboxes ?? {}, d.radioGroups ?? null, d.overlayFields ?? [], d.signatureFields ?? []]);
}

/** THE PLAN SET THE PACKAGE SHIPS (projectDocuments.shippedPlanSet — the #198 "newest" rule) and the
 *  sha256 of its stored bytes, or null when there is none. What an acknowledgement is bound to. */
export function planSetBinding(db: AppDb, projectId: string): ApprovalPlanSetBinding | null {
  const p = shippedPlanSet(db, projectId);
  if (!p) return null;
  return { documentId: p.id, sha256: fileSha256(p.storedPath) ?? "" };
}

/**
 * THE ITEMS A PERSON MUST ACKNOWLEDGE before approving THIS filing: the reviewer warnings that are
 * measured and hold this track, and the unverified form mappings on a form this track files.
 * `reviewer` is the gate's own report (repository.reviewerGateReportFor).
 */
export function acknowledgementItems(
  reviewerFindings: ReviewerFinding[], unverifiedForms: StoredTemplate[], track: SubmittalTrackType | null,
): ApprovalSheetOpenItem[] {
  return [
    ...reviewerItems(reviewerFindings, track).filter((i) => i.needsAcknowledgement),
    ...formItems(unverifiedForms, track),
  ];
}

function reviewerItems(findings: ReviewerFinding[], track: SubmittalTrackType | null): ApprovalSheetOpenItem[] {
  return findings
    .filter((f) => f.severity === "warning" && scopeHoldsTrack(findingHoldScope(f), track))
    .map((f) => {
      const measured = MEASURED_FINDING_IDS.has(f.id);
      return {
        key: `finding:${f.id}`, kind: "reviewer_warning", id: f.id, title: s(f.title),
        text: s(f.cityFeedback) || s(f.message), action: s(f.designTeamAction),
        measured, needsAcknowledgement: measured, contentHash: findingContentHash(f),
      };
    });
}

function formItems(forms: StoredTemplate[], track: SubmittalTrackType | null): ApprovalSheetOpenItem[] {
  return forms.filter((t) => formFiledOnTrack(t, track)).map((t) => ({
    key: `form:${t.templateId}`, kind: "form_mapping", id: `form:${t.templateId}`,
    title: `Unverified form mapping: ${t.def.formName}`,
    text: "Where this form's fields and signature are placed was derived automatically (read from the PDF or mapped by AI), and no person has checked the filled form.",
    action: "Open Build → App Docs, download the filled form and check every field and the signature, then Mark verified — or acknowledge here that you checked it.",
    measured: false, needsAcknowledgement: true, contentHash: formMappingContentHash(t),
  }));
}

/** The gate checks whose items the sheet lists one by one elsewhere: the reviewer findings and the
 *  form mappings. Every other warning check is listed as it stands. */
const LISTED_ITEM_BY_ITEM = new Set(["permit-requirements", "ahj-form-mapping-verified"]);

/**
 * EVERY OPEN ITEM OF THIS FILING, for the approval sheet: the items to acknowledge first, then the
 * other reviewer warnings and the submit gate's other warning checks whose scope holds this track.
 */
export function openReviewItems(
  reviewerFindings: ReviewerFinding[], unverifiedForms: StoredTemplate[], gateChecks: SubmitGateCheck[], track: SubmittalTrackType | null,
): ApprovalSheetOpenItem[] {
  const findings = reviewerItems(reviewerFindings, track);
  const checks: ApprovalSheetOpenItem[] = gateChecks
    .filter((c) => c.status === "warning" && !LISTED_ITEM_BY_ITEM.has(c.id) && scopeHoldsTrack(gateWarningScope(c), track))
    .map((c) => ({
      key: `gate:${c.id}`, kind: "gate_warning", id: c.id, title: s(c.title),
      text: (c.evidence ?? []).slice(0, 3).map(s).filter(Boolean).join("; ") || s(c.requirement),
      action: s(c.nextAction), measured: false, needsAcknowledgement: false,
      contentHash: sha(["gate", c.id, c.status, c.title, c.evidence ?? []]),
    }));
  return [
    ...findings.filter((i) => i.needsAcknowledgement),
    ...formItems(unverifiedForms, track),
    ...findings.filter((i) => !i.needsAcknowledgement),
    ...checks,
  ];
}

/** An approve request's acknowledgements, read defensively from a request body: anything malformed
 *  is dropped (an item not acknowledged is never invented). */
export function readAcknowledgements(raw: unknown): ApprovalAcknowledgements {
  const o = (raw && typeof raw === "object" ? raw : {}) as { planSet?: unknown; items?: unknown };
  const ps = (o.planSet && typeof o.planSet === "object" ? o.planSet : null) as { documentId?: unknown; sha256?: unknown } | null;
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    planSet: ps && s(ps.documentId) ? { documentId: s(ps.documentId), sha256: s(ps.sha256) } : null,
    items: items
      .map((i) => (i && typeof i === "object" ? i as { id?: unknown; contentHash?: unknown } : {}))
      .map((i) => ({ id: s(i.id), contentHash: s(i.contentHash) }))
      .filter((i) => i.id && i.contentHash)
      .slice(0, 200),
  };
}

const samePlanSet = (a: ApprovalPlanSetBinding | null, b: ApprovalPlanSetBinding | null): boolean =>
  (a?.documentId ?? "") === (b?.documentId ?? "") && (a?.sha256 ?? "") === (b?.sha256 ?? "");

/**
 * WHY THESE ACKNOWLEDGEMENTS DO NOT COVER WHAT NEEDS ONE NOW. Empty only when every item needing an
 * acknowledgement was acknowledged with the same content hash against the same plan set. Nothing
 * needing one → empty (there is nothing to acknowledge, whatever was recorded). Used twice: by the
 * approve route against the sheet the person ticked (refused before an approval is minted), and by
 * the run against the approval's recorded acknowledgements (the run stops at review).
 */
export function acknowledgementProblems(
  required: ApprovalSheetOpenItem[], given: ApprovalAcknowledgements | null, planSetNow: ApprovalPlanSetBinding | null,
): string[] {
  if (!required.length) return [];
  const out: string[] = [];
  if (!given || !samePlanSet(given.planSet, planSetNow)) {
    out.push(given
      ? "the plan set was replaced after the acknowledgements were given — acknowledge again against the plan set on file"
      : "no acknowledgement was recorded with the approval");
    if (!given) out.push(...required.map((i) => `not acknowledged: ${i.title}`));
    return out;
  }
  const byId = new Map(given.items.map((i) => [i.id, i.contentHash]));
  for (const item of required) {
    const hash = byId.get(item.id);
    if (!hash) out.push(`not acknowledged: ${item.title}`);
    else if (hash !== item.contentHash) out.push(`changed since it was acknowledged: ${item.title}`);
  }
  return out;
}
