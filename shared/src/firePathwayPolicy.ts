// A JURISDICTION'S ALTERNATIVE ROOF-ACCESS POLICY, SHAPE-CHECKED (review-audit draft 08). Pure: the code
// profile reads it through here at every door (mapRow, upsert, the verify route), so a malformed or
// partial payload is never read as a policy. Universal: the fields are kinds of rule, never a city.

import type { JurisdictionFirePathwayPolicy } from "./types";

const num = (v: unknown, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
};
const str = (v: unknown, max: number): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : undefined;
};

/** The policy, or null when it states no rule at all (a name or a link alone is not a policy). */
export function firePathwayPolicyOf(raw: unknown): JurisdictionFirePathwayPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const sourceUrl = str(r.sourceUrl, 500);
  const policy: JurisdictionFirePathwayPolicy = {
    ...(str(r.name, 200) ? { name: str(r.name, 200) } : {}),
    ...(num(r.arrayAreaMaxSqFt, 100000) ? { arrayAreaMaxSqFt: num(r.arrayAreaMaxSqFt, 100000) } : {}),
    ...(num(r.ridgeSetbackIn, 240) ? { ridgeSetbackIn: num(r.ridgeSetbackIn, 240) } : {}),
    ...(num(r.pathwayWidthIn, 240) ? { pathwayWidthIn: num(r.pathwayWidthIn, 240) } : {}),
    ...(num(r.pathwaysExemptMaxCoveragePct, 100) ? { pathwaysExemptMaxCoveragePct: num(r.pathwaysExemptMaxCoveragePct, 100) } : {}),
    ...(sourceUrl && /^https?:\/\//i.test(sourceUrl) ? { sourceUrl } : {}),
    ...(str(r.quote, 600) ? { quote: str(r.quote, 600) } : {}),
  };
  const states = policy.ridgeSetbackIn !== undefined || policy.pathwayWidthIn !== undefined || policy.pathwaysExemptMaxCoveragePct !== undefined;
  return states ? policy : null;
}
