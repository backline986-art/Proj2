// A GOVERNMENT PAGE VOUCHES FOR AN AUTHORITY'S OWN SITE (owner, 2026-11-13, decision card "Decide how
// a city or utility site that is not .gov gets trusted": "A government page vouches").
//
// The one shared official-source predicate (shared/src/officialSource.isOfficialSourceHost) trusts a
// government host on sight, and a non-government host only where it is recorded as the authority's
// own. Until now only a PERSON recorded that. Many cities and nearly every utility run on .org / .com,
// so their published facts stayed seeded. Now a government page can record it too, under these
// conditions, every one of them required:
//
//   1. Keelix READ the vouching page itself in this process (a ReadPage, ok, HTML). Never a model's
//      answer, never a search snippet.
//   2. That page's own final host is a government host (isGovernmentHost: .gov, .mil, a .xx.us
//      locality or state, a country's gov second level). arcgis.com and every other hosting or social
//      domain are not.
//   3. The page LINKS the site, and the link's own words name THIS authority ("City of Ashbury",
//      "Ashbury", "Ashbury Power"); a few words like "official website" around the name are allowed.
//   4. The linked host is not a government host (no vouch needed), not a permit or interconnection
//      platform, not a hosting / social / mapping domain, and its own domain carries the authority's
//      name (isAgencyOwnDomain for a jurisdiction; the utility's name or initials for a utility). A
//      utility's own domain on portalChannel's utility list (kept there for rule 5) is still its own.
//   5. One page, one answer: a page whose links name the same authority on two different sites
//      vouches for neither.
//
// A vouch is stored on the authority's lookup row with its evidence (the site, the vouching page,
// the link's words, the read time) and re-checked against conditions 2 to 4 every time it is read.
//
// WHAT A VOUCH NEVER DOES: it never makes a filing door official. Where a filing goes (a portal
// address, a filing email) and whether one is sent stay person-verified; filingDestinationProposals
// and the rule 5 carve-out read only person-verified hosts and never this module. It never outranks a
// person: a person-verified value is never replaced by an official read (rule 3).

import { isGovernmentHost, sourceHostOf } from "../../shared/src/officialSource";
import type { SiteVouch } from "../../shared/src/types";
import { sameAgencyName } from "./agencyName";
import type { PageReader, ReadPage } from "./agencyPageReader";
import { isAgencyOwnDomain } from "./permitPlatformCatalog";
import { isPermitPlatformUrl, isUtilityPlatformUrl, registrableDomain } from "./portalChannel";

export type { SiteVouch };

export interface VouchAuthority {
  kind: "ahj" | "utility";
  state: string;
  /** The authority's name, and any other names it goes by (an issuing agency's name for an AHJ). */
  names: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();

/** Domains that host other people's pages, maps or posts: never an authority's own site. */
const HOSTING_DOMAINS = new Set([
  "arcgis.com", "esri.com", "wixsite.com", "wix.com", "squarespace.com", "wordpress.com", "blogspot.com", "weebly.com",
  "godaddysites.com", "google.com", "goo.gl", "facebook.com", "fb.com", "twitter.com", "x.com", "instagram.com",
  "youtube.com", "youtu.be", "linkedin.com", "nextdoor.com", "tiktok.com", "pinterest.com", "flickr.com",
  "wikipedia.org", "civicplus.com", "municode.com", "ecode360.com", "amlegal.com", "codepublishing.com",
]);

/** Words a government page puts around a name in a link ("City of Ashbury official website"). */
const LINK_FILLER = /\b(?:official|website|web site|site|homepage|home page|visit|the|opens? in (?:a )?new (?:window|tab)|external link|link)\b/gi;
const UTILITY_FILLER = /\b(?:inc|co|corp|corporation|company|llc|the|of)\b/g;

const compactUtility = (s: string): string => str(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(UTILITY_FILLER, " ").replace(/\s+/g, "");
const utilityInitials = (s: string): string => str(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z\s]+/g, " ").replace(UTILITY_FILLER, " ")
  .split(/\s+/).filter((w) => w && w !== "and").map((w) => w[0]).join("");

/** Condition 3: the link's own words name this authority (and say little else). */
export function linkNamesAuthority(text: string, authority: VouchAuthority): boolean {
  const words = str(text).replace(LINK_FILLER, " ").replace(/[^A-Za-z0-9&'.\s-]+/g, " ").replace(/\s+/g, " ").trim();
  if (words.length < 3 || words.length > 80) return false;
  if (authority.kind === "ahj") return authority.names.some((n) => str(n) && sameAgencyName(words, n));
  const w = compactUtility(words);
  return w.length >= 4 && authority.names.some((n) => compactUtility(n) === w);
}

/** Condition 4: the linked host could be this authority's own site. */
export function hostCouldBeAuthorityOwn(host: string, authority: VouchAuthority): boolean {
  const h = str(host).toLowerCase().replace(/\.$/, "");
  if (!h || isGovernmentHost(h)) return false;
  const site = registrableDomain(h);
  if (!site.includes(".") || HOSTING_DOMAINS.has(site)) return false;
  if (isPermitPlatformUrl(`https://${h}/`)) return false;
  // A city is never vouched onto a utility's domain or an interconnection platform.
  if (authority.kind === "ahj") return !isUtilityPlatformUrl(`https://${h}/`) && isAgencyOwnDomain(h, authority.names, authority.state);
  // A UTILITY: the utility-platform list (portalChannel) also holds the big utilities' OWN domains
  // (idahopower.com, pge.com…), there so a permit track never lands on them (rule 5). For the utility
  // itself that list is no refusal: the name test below decides. An interconnection vendor's domain
  // (powerclerk.com, a tenant under it, a hosted site) never carries the utility's name in its own
  // registrable label, so it still fails.
  const label = site.split(".")[0].replace(/-/g, "");
  return authority.names.some((n) => {
    const c = compactUtility(n);
    const i = utilityInitials(n);
    return (c.length >= 5 && label.includes(c)) || (i.length >= 3 && label === i);
  });
}

/** Conditions 1 to 5 on one page Keelix read. Every vouch the page gives, or none. */
export function vouchesOnPage(page: ReadPage | null | undefined, authority: VouchAuthority, fetchedAt: string): SiteVouch[] {
  if (!page || !page.ok || page.kind !== "html" || !Array.isArray(page.links)) return [];
  const from = str(page.finalUrl) || str(page.url);
  const fromHost = sourceHostOf(from);
  if (!fromHost || !isGovernmentHost(fromHost)) return [];
  if (!/^\d{4}-\d{2}-\d{2}T/.test(fetchedAt) || Number.isNaN(Date.parse(fetchedAt))) return [];
  const out: SiteVouch[] = [];
  for (const l of page.links) {
    const host = sourceHostOf(str(l?.href));
    if (!host || !linkNamesAuthority(str(l?.text), authority) || !hostCouldBeAuthorityOwn(host, authority)) continue;
    if (!out.some((v) => v.host === host)) out.push({ host, vouchedByUrl: from.slice(0, 500), linkText: str(l.text).replace(/\s+/g, " ").slice(0, 120), fetchedAt });
  }
  // Condition 5: two different sites named as the same authority on one page — neither is vouched.
  return new Set(out.map((v) => registrableDomain(v.host))).size > 1 ? [] : out;
}

/** A stored vouch, re-checked when read: conditions 2 to 4 on what it holds. */
export function vouchHolds(v: unknown, authority: VouchAuthority): v is SiteVouch {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const host = str(r.host).toLowerCase();
  const fromHost = sourceHostOf(str(r.vouchedByUrl));
  const at = str(r.fetchedAt);
  return Boolean(host) && Boolean(fromHost) && isGovernmentHost(fromHost)
    && /^\d{4}-\d{2}-\d{2}T/.test(at) && !Number.isNaN(Date.parse(at))
    && linkNamesAuthority(str(r.linkText), authority) && hostCouldBeAuthorityOwn(host, authority);
}

/** The hosts a list of stored vouches makes official for this authority (each re-checked). */
export function vouchedHosts(vouches: unknown, authority: VouchAuthority): string[] {
  if (!Array.isArray(vouches)) return [];
  return [...new Set(vouches.filter((v) => vouchHolds(v, authority)).map((v) => (v as SiteVouch).host.toLowerCase()))];
}

/** A re-run's vouches beside the earlier row's: an earlier vouch is kept unless its vouching page was
 *  read again in this run and no longer gives it (the government page changed its link). */
export function mergeVouches(prior: unknown, fresh: SiteVouch[], rereadUrls: readonly string[]): SiteVouch[] {
  const key = (u: string) => str(u).toLowerCase().replace(/#.*$/, "").replace(/\/+$/, "");
  const reread = new Set(rereadUrls.map(key));
  const out: SiteVouch[] = [...fresh];
  for (const v of Array.isArray(prior) ? prior as SiteVouch[] : []) {
    if (!v || typeof v !== "object" || reread.has(key(v.vouchedByUrl))) continue;
    if (!out.some((o) => o.host === v.host)) out.push(v);
  }
  return out.slice(0, 6);
}

/**
 * THE VOUCH READ, for a lookup. Asked only when one of the answer's own pages is on a non-government
 * host that could be this authority's site and is not already official for it (`officialHosts`):
 * the government pages among the answer's cited pages and search results (≤ `maxReads`, cited first)
 * are read, and each gives what vouchesOnPage finds. Pages already read in the run (`pages`) count
 * without a second read. Never throws.
 */
export async function findSiteVouches(
  reader: PageReader | null | undefined,
  authority: VouchAuthority,
  input: { candidateUrls: readonly string[]; pages?: readonly ReadPage[]; officialHosts: readonly string[]; maxReads?: number },
): Promise<{ vouches: SiteVouch[]; read: string[] }> {
  const official = new Set(input.officialHosts.map((h) => registrableDomain(str(h).toLowerCase())));
  const urls = [...new Set(input.candidateUrls.map(str).filter((u) => /^https?:\/\//i.test(u)))];
  const wanted = urls.some((u) => {
    const h = sourceHostOf(u);
    return Boolean(h) && hostCouldBeAuthorityOwn(h, authority) && !official.has(registrableDomain(h));
  });
  if (!wanted) return { vouches: [], read: [] };
  const vouches: SiteVouch[] = [];
  const add = (vs: SiteVouch[]) => { for (const v of vs) if (!vouches.some((x) => x.host === v.host)) vouches.push(v); };
  const now = () => new Date().toISOString();
  for (const p of input.pages ?? []) add(vouchesOnPage(p, authority, now()));
  const read: string[] = [];
  if (!reader) return { vouches, read };
  const already = new Set((input.pages ?? []).flatMap((p) => [str(p.url), str(p.finalUrl)]));
  const gov = urls.filter((u) => isGovernmentHost(sourceHostOf(u)) && !already.has(u) && !/\.pdf(?:$|[?#])/i.test(u));
  for (const u of gov.slice(0, input.maxReads ?? 2)) {
    try {
      const page = await reader.read(u);
      read.push(u);
      if (page.ok && page.finalUrl && page.finalUrl !== u) read.push(page.finalUrl);
      add(vouchesOnPage(page, authority, now()));
    } catch { /* an unreadable page vouches for nothing */ }
  }
  return { vouches, read };
}
