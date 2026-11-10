// WHERE A RULE'S VALUE CAME FROM, IN WORDS (review-audit draft 07).
//
// A finding measured against jurisdiction data (an adopted edition, a design criterion, a pathway
// width, a minimum ground snow load) says which tier the value it compared against stands on, so a
// person reading the gate can tell a seeded guess from a person's verification. The words follow
// #683's rule (shared/src/officialSource): an OFFICIAL value is shown as "from <host>", never as
// person-verified; a seeded one says it is not verified; only a person's verification names a person.
// A model-code rule (the NEC's own arithmetic) names the code it applies.
// Pure: no DB, no network. One wording for the dashboard, the approval sheet and the reports.

import { sourceHostOf } from "./officialSource";

import type { ReviewerRuleBasis, RuleBasisTier } from "./types";
export type { ReviewerRuleBasis, RuleBasisTier } from "./types";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const looksLikeEmail = (s: string): boolean => /@/.test(s);

/** The tier in words: "from le.utah.gov", "seeded, not verified", "person-verified by Pat Reviewer",
 *  "model code (NEC 2023 690.7)". */
export function ruleBasisLabel(basis: Pick<ReviewerRuleBasis, "tier" | "source" | "sourceUrl" | "verifiedBy">): string {
  const source = str(basis.source);
  switch (basis.tier) {
    case "official": {
      const host = sourceHostOf(str(basis.sourceUrl));
      return `from ${host || source || "the authority's official page"}`;
    }
    case "verified": {
      const who = str(basis.verifiedBy);
      if (who === "reference-seed") return "verified via the shipped reference seed, not by a person here";
      return `person-verified${who && !looksLikeEmail(who) ? ` by ${who}` : ""}`;
    }
    case "model_code":
      return `model code${source ? ` (${source})` : ""}`;
    default:
      return "seeded, not verified";
  }
}

export function makeRuleBasis(tier: RuleBasisTier, source: string, sourceUrl = "", verifiedBy?: string): ReviewerRuleBasis {
  const basis = { tier, source: str(source), sourceUrl: str(sourceUrl), ...(tier === "verified" && str(verifiedBy) ? { verifiedBy: str(verifiedBy) } : {}) };
  return { ...basis, label: ruleBasisLabel(basis) };
}

const TIER_RANK: Record<RuleBasisTier, number> = { seeded: 0, official: 1, verified: 2, model_code: 3 };

/** One basis for a finding that compared several values: the WEAKEST tier among them (a check is
 *  only as settled as its least-settled value), its source naming every distinct source. */
export function weakestRuleBasis(list: ReadonlyArray<ReviewerRuleBasis | null | undefined>): ReviewerRuleBasis | null {
  const all = list.filter((b): b is ReviewerRuleBasis => !!b);
  if (!all.length) return null;
  const weakest = all.reduce((a, b) => (TIER_RANK[b.tier] < TIER_RANK[a.tier] ? b : a));
  const sources = [...new Set(all.map((b) => b.source).filter(Boolean))];
  if (sources.length <= 1) return weakest;
  return { ...weakest, source: sources.join("; ") };
}
