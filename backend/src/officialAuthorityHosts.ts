// THE AUTHORITY'S OWN DOMAINS A PERSON VERIFIED (#683) — the second half of
// shared/src/officialSource.isOfficialSourceHost: a city or utility on .org / .com is an official
// source only where a PERSON verified that domain as the authority's own. Kept apart from
// issuerDesignCriteria.ts (which imports llm, which imports codeProfiles) so codeProfiles can read it
// statically. Reads only.
import type { AppDb } from "./db";
import { getPermitProcessLookup } from "./permitProcess";
import { isAgencyOwnDomain } from "./permitPlatformCatalog";
import { isPermitPlatformUrl } from "./portalChannel";
import { vouchedHosts } from "./governmentVouches";

/** Every http(s) URL anywhere in a value (a stored lookup's citations), depth-bounded. */
export function urlsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || v == null) return out;
  if (typeof v === "string") { if (/^https?:\/\//i.test(v.trim())) out.push(v.trim()); return out; }
  if (Array.isArray(v)) { for (const x of v) urlsIn(x, out, depth + 1); return out; }
  if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) urlsIn(x, out, depth + 1);
  return out;
}

/**
 * THE AUTHORITY'S OWN DOMAINS A PERSON VERIFIED (#683): hosts cited by this AHJ's HUMAN-verified
 * permit-process lookup (verified_at + a named verifier), plus any URLs the caller holds from a row a
 * person verified, that name the jurisdiction (the own-site test of issuerDesignCriteria.isIssuerHost without its official-TLD
 * half — a city on .org / .com qualifies only this way). A seeded lookup, a guess from the name, a
 * permit platform or a vendor host never does. Reads only.
 */
export function personVerifiedAuthorityHosts(db: AppDb | null, state: string, ahj: string, verifiedUrls: string[] = []): string[] {
  const urls: string[] = [...verifiedUrls];
  const lookup = db ? getPermitProcessLookup(db, state, ahj) : null;
  if (lookup && lookup.verifiedAt && String(lookup.verifiedBy ?? "").trim()) urlsIn(lookup, urls);
  const hosts = new Set<string>();
  for (const u of urls) {
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (host && !isPermitPlatformUrl(`https://${host}/`) && isAgencyOwnDomain(host, [ahj], state)) hosts.add(host);
  }
  return [...hosts];
}


/** The names a government page may use for this AHJ: its own, and the agency its lookup says issues
 *  its permits. */
export function vouchNamesFor(ahj: string, lookup: { issuingAgency?: { value?: unknown } | null } | null | undefined): string[] {
  return [...new Set([String(ahj ?? "").trim(), String(lookup?.issuingAgency?.value ?? "").trim()].filter(Boolean))];
}

/**
 * THE AUTHORITY'S OWN DOMAINS A GOVERNMENT PAGE VOUCHED FOR (owner, 2026-11-13; governmentVouches.ts):
 * the hosts this AHJ's lookup row records as linked, by name, from a government page Keelix read, each
 * re-checked as it is read. A verified row's vouches count too (a person's row is no weaker). Reads only.
 */
export function governmentVouchedAuthorityHosts(db: AppDb | null, state: string, ahj: string): string[] {
  const lookup = db ? getPermitProcessLookup(db, state, ahj) : null;
  if (!lookup?.siteVouches?.length) return [];
  return vouchedHosts(lookup.siteVouches, { kind: "ahj", state, names: vouchNamesFor(ahj, lookup) });
}

/**
 * THE AUTHORITY'S OWN DOMAINS, for grading a FACT official (isOfficialSourceHost's second half): a
 * person's, and a government page's. NEVER for a filing door: where a filing goes, and whether one is
 * sent, read personVerifiedAuthorityHosts alone (filingDestinationProposals). Reads only.
 */
export function officialAuthorityHosts(db: AppDb | null, state: string, ahj: string, verifiedUrls: string[] = []): string[] {
  let vouched: string[] = [];
  try { vouched = governmentVouchedAuthorityHosts(db, state, ahj); } catch { vouched = []; }
  return [...new Set([...personVerifiedAuthorityHosts(db, state, ahj, verifiedUrls), ...vouched])];
}
