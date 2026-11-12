// KEELIX CONFIRMS THAT A COUNTY'S OWN GOVERNMENT PAGE LINKS ITS HOSTED PARCEL MAP (draft 16 B, automated).
//
// Many counties publish their parcel map on a hosted map platform (ArcGIS Online, run by Esri), never a
// government host. Draft 16 B let a job's street address go there only when a NAMED PERSON had checked
// that the county's own government page links that exact service. The owner asked for that check to be
// automatic (2026-11-12, "would like it to be automated if we could"), under his one official-source
// rule (#683): Keelix itself reads the county's own GOVERNMENT page, finds the link in the bytes it
// retrieved, and records the page, the link as written and when it read it. Only then is the service
// asked. The platform itself never becomes a government host: the county's link is what vouches.
//
// WHAT COUNTS AS THE COUNTY LINKING THE SERVICE (the one predicate, linkMatchFor):
//   - "service": the page links the service root itself, or something under it (a layer, a query);
//   - "organisation": on a SHARED platform host (servicesN.arcgis.com, where the first path segment is
//     the publishing organisation's id), the page links another URL of the SAME organisation on the
//     SAME host — the county publishes under that organisation id;
//   - "organisation_site": the page links the organisation's own site (<name>.maps.arcgis.com), and that
//     site's public self-description names the same organisation id as the service's path.
// The two organisation forms stand only while ACCEPT_SAME_ORGANISATION is true (the owner's card,
// 2026-11-12): most county pages link their map APP, not the data service behind it.
//
// WHAT THIS READS (and nothing else; mayFetchForLinkCheck is the door, every request passes it):
//   - the record's sourceUrl: https, a GOVERNMENT host (officialSource.isGovernmentHost), redirects
//     followed only to the same host;
//   - for "organisation_site" only: https://<name>.maps.arcgis.com/sharing/rest/portals/self?f=json.
// NO ADDRESS, name, account or anything of a job is ever in these requests: they run before any address
// is sent, and the address is sent (by parcelJurisdiction.askParcelService) only to a service whose
// confirmation holds (confirmationHolds) at the moment of asking.
//
// A confirmation is good for CONFIRM_TTL_MS (re-read after); a page that no longer links the service
// is recorded as refused, and the service stops being asked. Stored in parcel_service_link_checks
// (migration v86): shared on purpose like the other jurisdiction tables (a public page, a public link).
import { createHash } from "node:crypto";
import { isGovernmentHost, sourceHostOf } from "../../shared/src/officialSource";
import type { AppDb } from "./db";
import { logger } from "./logger";
import { nowIso } from "./time";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** The owner's choice on how close the county's link must be (card 2026-11-12). true = the same
 *  organisation on the platform counts; false = only a link to the exact service root. */
export const ACCEPT_SAME_ORGANISATION = true;

/** A confirmation is used for 30 days, then the county's page is read again before the next ask. */
export const CONFIRM_TTL_MS = 30 * 24 * 3600_000;
/** A refused check is not repeated for a day (the page is not re-read on every job). */
export const REFUSED_RETRY_MS = 24 * 3600_000;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;
const MAX_ORG_SITES = 3;

export type LinkMatch = "service" | "organisation" | "";

/** A shared platform host whose first path segment is the publishing organisation's id. */
function isSharedServicesHost(host: string): boolean {
  return /^(services|tiles|features|vectortiles)\d*\.arcgis\.com$/.test(str(host).toLowerCase());
}

/** An organisation's own site on the platform (<name>.maps.arcgis.com). */
export function isOrganisationSiteHost(host: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}\.maps\.arcgis\.com$/.test(str(host).toLowerCase());
}

const RESERVED_SEGMENTS = new Set(["arcgis", "rest", "services", "sharing", "apps", "home", "content", "portal", "server"]);

/** The organisation id a URL on a shared services host names (its first path segment), or "". */
export function organisationIdOf(url: string): string {
  const host = sourceHostOf(url);
  if (!isSharedServicesHost(host)) return "";
  let seg = "";
  try { seg = new URL(url).pathname.split("/").filter(Boolean)[0] ?? ""; } catch { return ""; }
  return /^[A-Za-z0-9]{8,32}$/.test(seg) && !RESERVED_SEGMENTS.has(seg.toLowerCase()) ? seg : "";
}

/** `url` is the root, or sits under it (the root, then "/", "?" or the end). Case-sensitive, as a
 *  path is. */
function underRoot(url: string, root: string): boolean {
  if (!root || !url.startsWith(root)) return false;
  const next = url.charAt(root.length);
  return next === "" || next === "/" || next === "?";
}

/** How a linked URL relates to the service root ("" = it does not vouch for it). Same host always. */
export function linkMatchFor(href: string, serviceRoot: string): LinkMatch {
  const h = str(href);
  const root = str(serviceRoot).replace(/\/+$/, "");
  const host = sourceHostOf(h);
  if (!host || !/^https:\/\//i.test(h) || host !== sourceHostOf(root)) return "";
  // Compare from the path on: the host's case never matters, a path's does.
  let hrefTail = "";
  let rootTail = "";
  try {
    const hu = new URL(h);
    const ru = new URL(root);
    hrefTail = `${hu.pathname.replace(/\/+$/, "")}${hu.search}`;
    rootTail = ru.pathname.replace(/\/+$/, "");
  } catch { return ""; }
  if (rootTail && (hrefTail === rootTail || underRoot(hrefTail, rootTail))) return "service";
  const org = organisationIdOf(root);
  if (org && organisationIdOf(h) === org) return "organisation";
  return "";
}

/** Does this match vouch, under the owner's choice? */
export function matchAccepted(m: LinkMatch | "organisation_site"): boolean {
  if (m === "service") return true;
  if (m === "organisation" || m === "organisation_site") return ACCEPT_SAME_ORGANISATION;
  return false;
}

// ── Reading a page's links (pure) ───────────────────────────────────────────────────────────────
export interface PageLink {
  /** The URL, resolved and entity-decoded. */
  url: string;
  /** The page's own bytes that carry it (the tag, or the words around a bare URL), verbatim. */
  quote: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Blank out what is not the page's own published content (scripts, styles, comments), keeping every
 *  offset, so a quote taken from what is left is still a substring of the retrieved bytes. */
function blankNonContent(html: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, blank)
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, blank)
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, blank);
}

/** Every link the page itself publishes: <a href>, <area href>, <iframe src> (an embedded map), and a
 *  bare https URL written in its text. Scripts, styles and comments do not count (a third party's
 *  embed code is not the county's word). Pure. */
export function pageLinks(html: string, pageUrl: string): PageLink[] {
  const raw = String(html ?? "");
  const content = blankNonContent(raw);
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const push = (value: string, quote: string) => {
    let url = "";
    try { url = new URL(decodeEntities(value.trim()), pageUrl).toString(); } catch { return; }
    if (!/^https?:\/\//i.test(url)) return;
    const k = `${url}\n${quote}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ url, quote: quote.slice(0, 600) });
  };
  const tagRe = /<(a|area|iframe)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content))) {
    const tag = m[0];
    const attr = m[1].toLowerCase() === "iframe" ? "src" : "href";
    const am = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    if (!am) continue;
    // The quote: the tag and (for a link) its words up to the closing tag, as the page wrote them.
    let quote = raw.slice(m.index, m.index + tag.length);
    if (m[1].toLowerCase() === "a") {
      const close = content.slice(m.index + tag.length, m.index + tag.length + 400).search(/<\/a\s*>/i);
      if (close >= 0) quote = raw.slice(m.index, m.index + tag.length + close + 4);
    }
    push(am[1] ?? am[2] ?? am[3] ?? "", quote);
  }
  // A bare URL in the page's text (outside any tag).
  const textOnly = content.replace(/<[^>]*>/g, (t) => " ".repeat(t.length));
  const urlRe = /https:\/\/[^\s"'<>()]+/gi;
  while ((m = urlRe.exec(textOnly))) {
    const value = m[0].replace(/[.,;:]+$/, "");
    const from = Math.max(0, m.index - 80);
    const to = Math.min(raw.length, m.index + value.length + 40);
    push(value, raw.slice(from, to).trim());
  }
  return out;
}

/** The best link on the page vouching for the service, or null. "service" beats "organisation". */
export function findServiceLink(html: string, pageUrl: string, serviceRoot: string): (PageLink & { match: LinkMatch }) | null {
  let best: (PageLink & { match: LinkMatch }) | null = null;
  for (const l of pageLinks(html, pageUrl)) {
    const match = linkMatchFor(l.url, serviceRoot);
    if (!match || !matchAccepted(match)) continue;
    if (!best || (best.match !== "service" && match === "service")) best = { ...l, match };
  }
  return best;
}

// ── The fetch (a seam: tests never reach a network) ─────────────────────────────────────────────
export type LinkCheckFetch = (url: string) => Promise<{ status: number; text: string; location?: string }>;

/** THE DOOR for every request this module makes. The county's page: https on a GOVERNMENT host. An
 *  organisation site's public self-description: exactly https://<name>.maps.arcgis.com/sharing/rest/
 *  portals/self?f=json. Nothing else, ever — and never anything of a job. */
export function mayFetchForLinkCheck(url: string, stage: "page" | "organisation_site"): boolean {
  const u = str(url);
  if (!/^https:\/\//i.test(u)) return false;
  let parsed: URL;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return false;
  const host = parsed.hostname.toLowerCase();
  if (stage === "page") return isGovernmentHost(host);
  return isOrganisationSiteHost(host) && parsed.pathname === "/sharing/rest/portals/self" && parsed.search === "?f=json";
}

const defaultFetch: LinkCheckFetch = async (url) => {
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { Accept: "text/html,application/json", "User-Agent": "Mozilla/5.0 (compatible; jurisdiction-check)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = (await res.text()).slice(0, MAX_PAGE_BYTES);
  return { status: res.status, text, location: res.headers.get("location") ?? undefined };
};
let fetchForTests: LinkCheckFetch | null = null;
/** Tests answer with saved pages. null = the real fetch. */
export function setLinkCheckFetchForTests(fn: LinkCheckFetch | null): void {
  fetchForTests = fn;
}

/** Read the county's page: the door on every hop; a redirect is followed only to the SAME host. */
async function readCountyPage(sourceUrl: string): Promise<{ ok: true; url: string; text: string } | { ok: false; detail: string }> {
  const host = sourceHostOf(sourceUrl);
  let url = sourceUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!mayFetchForLinkCheck(url, "page") || sourceHostOf(url) !== host) return { ok: false, detail: `${sourceHostOf(url) || "the page"} is not the county's own government page` };
    let res: { status: number; text: string; location?: string };
    try { res = await (fetchForTests ?? defaultFetch)(url); } catch (err) {
      const msg = err instanceof Error ? err.name === "TimeoutError" ? "timed out" : err.message : String(err);
      return { ok: false, detail: `the county's page did not answer (${msg.slice(0, 120)})` };
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      let next = "";
      try { next = new URL(res.location, url).toString(); } catch { next = ""; }
      if (!next || sourceHostOf(next) !== host) return { ok: false, detail: `the county's page redirects off ${host}` };
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, detail: `the county's page answered HTTP ${res.status}` };
    return { ok: true, url, text: res.text };
  }
  return { ok: false, detail: "the county's page redirects too many times" };
}

/** The organisation id an organisation site describes itself with, or "". */
async function organisationIdOfSite(host: string): Promise<{ id: string; url: string }> {
  const url = `https://${host}/sharing/rest/portals/self?f=json`;
  if (!mayFetchForLinkCheck(url, "organisation_site")) return { id: "", url };
  try {
    const res = await (fetchForTests ?? defaultFetch)(url);
    if (res.status < 200 || res.status >= 300) return { id: "", url };
    const body = JSON.parse(res.text) as Row;
    const id = str(body?.id);
    return { id: /^[A-Za-z0-9]{8,32}$/.test(id) ? id : "", url };
  } catch { return { id: "", url }; }
}

// ── The record of a check (parcel_service_link_checks, migration v86) ───────────────────────────
export interface ServiceLinkCheck {
  sourceKey: string;
  sourceUrl: string;
  serviceRoot: string;
  status: "confirmed" | "refused";
  /** How the page vouches: service | organisation | organisation_site ("" when refused). */
  kind: "service" | "organisation" | "organisation_site" | "";
  /** The page as read (after same-host redirects). */
  pageUrl: string;
  /** The link as the page carries it (resolved), and the page's own bytes around it, verbatim. */
  linkUrl: string;
  quote: string;
  /** organisation_site: the organisation id the site gave, and where it was read. */
  organisationId: string;
  organisationSource: string;
  pageSha256: string;
  detail: string;
  checkedAt: string;
}

export function readServiceLinkCheck(db: AppDb, sourceKey: string, sourceUrl: string, serviceRoot: string): ServiceLinkCheck | null {
  let row: Row | null | undefined;
  try {
    row = db.get<Row>(
      "SELECT * FROM parcel_service_link_checks WHERE source_key = ? AND source_url = ? AND service_root = ?",
      [sourceKey, sourceUrl, serviceRoot],
    );
  } catch { return null; }
  if (!row) return null;
  const status = str(row.status);
  if (status !== "confirmed" && status !== "refused") return null;
  const kind = str(row.kind);
  return {
    sourceKey: str(row.source_key), sourceUrl: str(row.source_url), serviceRoot: str(row.service_root), status,
    kind: kind === "service" || kind === "organisation" || kind === "organisation_site" ? kind : "",
    pageUrl: str(row.page_url), linkUrl: str(row.link_url), quote: str(row.quote),
    organisationId: str(row.organisation_id), organisationSource: str(row.organisation_source),
    pageSha256: str(row.page_sha256), detail: str(row.detail), checkedAt: str(row.checked_at),
  };
}

function writeServiceLinkCheck(db: AppDb, c: ServiceLinkCheck): void {
  db.run(
    `INSERT INTO parcel_service_link_checks
       (source_key, source_url, service_root, status, kind, page_url, link_url, quote, organisation_id, organisation_source, page_sha256, detail, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key, source_url, service_root) DO UPDATE SET
       status = excluded.status, kind = excluded.kind, page_url = excluded.page_url, link_url = excluded.link_url,
       quote = excluded.quote, organisation_id = excluded.organisation_id, organisation_source = excluded.organisation_source,
       page_sha256 = excluded.page_sha256, detail = excluded.detail, checked_at = excluded.checked_at`,
    [c.sourceKey, c.sourceUrl, c.serviceRoot, c.status, c.kind, c.pageUrl.slice(0, 1000), c.linkUrl.slice(0, 1000), c.quote.slice(0, 600),
      c.organisationId.slice(0, 64), c.organisationSource.slice(0, 300), c.pageSha256, c.detail.slice(0, 400), c.checkedAt],
  );
}

/**
 * DOES THIS CONFIRMATION STILL LET THE SERVICE BE ASKED? Re-checked at the door from the stored record
 * alone (pure): confirmed, younger than CONFIRM_TTL_MS, read from the record's own government page
 * (same host), for exactly this record's page and service root, and the stored link still vouches under
 * the owner's choice.
 */
export function confirmationHolds(
  c: ServiceLinkCheck | null | undefined,
  source: { sourceUrl: string; verifiedService: string },
  now = Date.now(),
): boolean {
  if (!c || c.status !== "confirmed") return false;
  const age = now - Date.parse(c.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age >= CONFIRM_TTL_MS) return false;
  if (c.sourceUrl !== source.sourceUrl || c.serviceRoot !== source.verifiedService || !source.verifiedService) return false;
  const pageHost = sourceHostOf(c.pageUrl);
  if (!pageHost || !isGovernmentHost(pageHost) || pageHost !== sourceHostOf(source.sourceUrl)) return false;
  if (!c.quote) return false;
  if (c.kind === "service" || c.kind === "organisation") {
    const m = linkMatchFor(c.linkUrl, source.verifiedService);
    return m === c.kind && matchAccepted(m);
  }
  if (c.kind === "organisation_site") {
    const org = organisationIdOf(source.verifiedService);
    return matchAccepted("organisation_site") && !!org && c.organisationId === org && isOrganisationSiteHost(sourceHostOf(c.linkUrl));
  }
  return false;
}

/** Is a fresh check (confirmed, or refused within the retry window) already on file? */
export function linkCheckFresh(c: ServiceLinkCheck | null, now = Date.now()): boolean {
  if (!c) return false;
  const age = now - Date.parse(c.checkedAt);
  if (!Number.isFinite(age) || age < 0) return false;
  return c.status === "confirmed" ? age < CONFIRM_TTL_MS : age < REFUSED_RETRY_MS;
}

/**
 * READ THE COUNTY'S OWN PAGE AND CONFIRM IT LINKS THE SERVICE. A job step (network), never a page read.
 * Records the outcome (confirmed with its evidence, or refused with the reason) and returns it. Never
 * throws. Carries nothing of any job: only the record's public page and, for an organisation site, its
 * public self-description.
 */
export async function confirmParcelServiceLink(
  db: AppDb,
  source: { key: string; county: string; sourceUrl: string; verifiedService: string },
): Promise<ServiceLinkCheck> {
  const base = {
    sourceKey: source.key, sourceUrl: source.sourceUrl, serviceRoot: source.verifiedService,
    kind: "" as ServiceLinkCheck["kind"], pageUrl: "", linkUrl: "", quote: "", organisationId: "", organisationSource: "", pageSha256: "",
  };
  const refuse = (detail: string, extra: Partial<ServiceLinkCheck> = {}): ServiceLinkCheck => {
    const c: ServiceLinkCheck = { ...base, ...extra, status: "refused", kind: "", detail, checkedAt: nowIso() };
    try { writeServiceLinkCheck(db, c); } catch { /* best effort */ }
    logger.info("parcel-jurisdiction", "county page does not confirm the hosted parcel service", { county: source.county, page: sourceHostOf(source.sourceUrl), service: sourceHostOf(source.verifiedService), detail });
    return c;
  };
  if (!source.verifiedService) return refuse("the record names no service root");
  if (!mayFetchForLinkCheck(source.sourceUrl, "page")) return refuse(`${sourceHostOf(source.sourceUrl) || "sourceUrl"} is not an https government page`);
  const page = await readCountyPage(source.sourceUrl);
  if (!page.ok) return refuse(page.detail);
  const pageSha256 = createHash("sha256").update(page.text).digest("hex");
  const seen = { pageUrl: page.url, pageSha256 };
  const confirm = (c: Partial<ServiceLinkCheck>): ServiceLinkCheck => {
    const out: ServiceLinkCheck = { ...base, ...seen, ...c, status: "confirmed", detail: "", checkedAt: nowIso() };
    writeServiceLinkCheck(db, out);
    logger.info("parcel-jurisdiction", "county page confirms the hosted parcel service", { county: source.county, page: sourceHostOf(page.url), service: sourceHostOf(source.verifiedService), kind: out.kind });
    return out;
  };
  const direct = findServiceLink(page.text, page.url, source.verifiedService);
  if (direct) return confirm({ kind: direct.match === "service" ? "service" : "organisation", linkUrl: direct.url, quote: direct.quote });
  // The organisation's own site, linked from the page: does it describe itself as the service's
  // organisation?
  const org = organisationIdOf(source.verifiedService);
  if (org && matchAccepted("organisation_site")) {
    const sites = new Map<string, PageLink>();
    for (const l of pageLinks(page.text, page.url)) {
      const h = sourceHostOf(l.url);
      if (/^https:\/\//i.test(l.url) && isOrganisationSiteHost(h) && !sites.has(h)) sites.set(h, l);
    }
    for (const [host, link] of [...sites.entries()].slice(0, MAX_ORG_SITES)) {
      const { id, url } = await organisationIdOfSite(host);
      if (id && id === org) return confirm({ kind: "organisation_site", linkUrl: link.url, quote: link.quote, organisationId: id, organisationSource: url });
    }
    if (sites.size) return refuse(`the page links ${[...sites.keys()].slice(0, MAX_ORG_SITES).join(", ")}, but none is the service's organisation`, seen);
  }
  return refuse(`the page does not link ${sourceHostOf(source.verifiedService)}${org ? ` (organisation ${org})` : ""}`, seen);
}
