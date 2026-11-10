// WHAT A UTILITY'S APPLICATION ASKS FOR, PROPOSED BY ITS FILING LOOKUP (review-audit draft 03, last
// bullet; follow-up to worker-utilchecks 81498cf5).
//
// The utility filing lookup (utilityFilingLookup.runUtilityFilingLookup) already searches the utility's
// own interconnection pages. It now also proposes the items the utility's application asks for (a meter
// photo, a one-line, the inverter's settings…), each with the page that says so and the sentence copied
// verbatim. That answer is only a PROPOSAL:
//   - utilityRequirementReadsOf shape-checks it: a known kind, an http(s) page the search returned, a
//     quote whose words name the item (the same QUOTE_NAMES_REQUIREMENT a person's item must pass). A
//     lookup that was not web-grounded proposes nothing: model memory is never a requirement;
//   - landResearchedUtilityRequirements decides where each lands on the utility's filing row
//     (utility_filing_lookups.application_requirements_json):
//       OFFICIAL only through #683's one landing function (landingTierFor) on bytes THIS process read
//         from the page: a government host or a domain a person verified as the utility's own, the
//         quote found in the retrieved text, a fetched-at time. An official item may block only when
//         its own words make it mandatory ("must", "required", "shall"…); otherwise it warns;
//       SEEDED otherwise, and a seeded item always warns (whenMissing "warning": Helm's #637 bar; a
//         model's quote is not a read);
//       never over a person's item: an official read that disagrees with it (a different "when
//         missing") is recorded once as a conflict for a person, and the row is unchanged (rule 3);
//       an official item from another host is never replaced, and a seeded proposal never replaces the
//         shipped seed's item for that kind (so today's findings do not move when nothing new arrives).
//   - the page reads run inside the lookup's own background run (ensureUtilityFilingLookedUp), never on
//     a read path: every GET still writes nothing and fetches nothing.
// Nothing here decides WHERE a filing goes or WHETHER one is sent: requirement items are checks on the
// package, not filing targets or doors. Nothing names a utility, a state or a portal.
import type { UtilityApplicationRequirement, UtilityRequirementKey } from "../../shared/src/types";
import { UTILITY_REQUIREMENT_KEYS } from "../../shared/src/types";
import { isOfficialSourceHost, landingTierFor, sourceHostOf } from "../../shared/src/officialSource";
import type { AppDb } from "./db";
import type { PageReader } from "./agencyPageReader";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { portalHostOf } from "./portalChannel";
import { nowIso } from "./time";
import { utilityFilingKey } from "./utilityFilingLookup";
import { filingRowRequirements, QUOTE_NAMES_REQUIREMENT, shippedRecordFor, utilityPersonVerifiedHosts } from "./utilityRequirements";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export { UTILITY_REQUIREMENTS_RESEARCH_RULE, UTILITY_REQUIREMENTS_RESEARCH_SCHEMA } from "./utilityRequirementsResearchPrompt";

export interface UtilityRequirementRead {
  key: UtilityRequirementKey;
  sourceName: string;
  sourceUrl: string;
  quote: string;
}

const MAX_READS = 12;
/** Pages read to confirm official items, per lookup (each on the reader's politeness and budget). */
export const UTILITY_REQUIREMENTS_CONFIRM_MAX_READS = 4;

/** The lookup answer's applicationRequirements member, shape-checked. `seenUrls` = every URL the
 *  search returned or opened; an answer that was not web-grounded yields nothing. */
export function utilityRequirementReadsOf(raw: unknown, seenUrls: string[], webGrounded: boolean): { reads: UtilityRequirementRead[]; dropped: string[] } {
  const reads: UtilityRequirementRead[] = [];
  const dropped: string[] = [];
  if (!webGrounded || !Array.isArray(raw)) return { reads, dropped };
  const seenHosts = new Set(seenUrls.map((u) => portalHostOf(u)).filter(Boolean));
  for (const entry of raw.slice(0, 24)) {
    const o = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const key = str(o.key);
    const sourceUrl = str(o.sourceUrl).slice(0, 500);
    const quote = str(o.quote).replace(/\s+/g, " ").slice(0, 600);
    if (!(UTILITY_REQUIREMENT_KEYS as readonly string[]).includes(key)) { dropped.push(`requirement "${key.slice(0, 40)}": not a known kind`); continue; }
    const k = key as UtilityRequirementKey;
    if (!/^https?:\/\//i.test(sourceUrl) || quote.length < 8) { dropped.push(`requirement ${k}: no source page and its words`); continue; }
    if (!seenHosts.has(portalHostOf(sourceUrl))) { dropped.push(`requirement ${k}: ${portalHostOf(sourceUrl) || sourceUrl} is not a page the search returned`); continue; }
    if (!QUOTE_NAMES_REQUIREMENT[k](quote)) { dropped.push(`requirement ${k}: the quoted words do not name it ("${quote.slice(0, 80)}")`); continue; }
    if (reads.some((r) => r.key === k)) continue;
    reads.push({ key: k, sourceName: str(o.sourceName).slice(0, 200) || sourceHostOf(sourceUrl), sourceUrl, quote });
    if (reads.length >= MAX_READS) break;
  }
  return { reads, dropped };
}

export { utilityPersonVerifiedHosts } from "./utilityRequirements";

/** Mandatory words: an official item whose own sentence makes it a requirement may block; else it warns. */
const MANDATORY = /\b(?:must|shall|required?|requires|mandatory|need(?:s)? to)\b/i;

export interface RetrievedPage { url: string; text: string; fetchedAt: string }

export interface UtilityRequirementsLanding {
  saved: boolean;
  reason: string;
  /** Items written, "<key> (<tier>)". */
  landed: string[];
  skipped: string[];
  /** Official reads that disagree with a person's item (recorded once each; the row is unchanged). */
  conflicts: Array<{ key: UtilityRequirementKey; current: string; found: string; sourceUrl: string; quote: string }>;
  pagesRead?: Array<{ url: string; ok: boolean; reason: string }>;
}

const CONFLICT_ACTION = "utility_filing.application_requirement_official_conflict";
const ACTOR = "utility-requirements-research";

/**
 * LAND A LOOKUP'S REQUIREMENT READS on the utility's filing row (see the header). `reader` reads the
 * official pages to confirm their quotes (null = no page reads: everything lands seeded); `retrieved` =
 * pages the caller already read. Never throws on a page read. The filing row must exist (the lookup
 * writes it first); this never creates one.
 */
export async function landResearchedUtilityRequirements(
  db: AppDb,
  where: { state: string; utility: string },
  reads: UtilityRequirementRead[],
  opts: { reader?: PageReader | null; retrieved?: RetrievedPage[]; at?: string } = {},
): Promise<UtilityRequirementsLanding> {
  const out: UtilityRequirementsLanding = { saved: false, reason: "", landed: [], skipped: [], conflicts: [] };
  if (!reads.length) return { ...out, reason: "no usable requirement read" };
  // The row as stored (a writer never writes a read-time downgrade back).
  const { rowExists, requirements: onRow } = filingRowRequirements(db, where.state, where.utility, { honour: false });
  if (!rowExists) return { ...out, reason: "no filing record for this utility" };
  const hosts = utilityPersonVerifiedHosts(db, where.state, where.utility, onRow);

  // Read each official-host page once, so the landing checks the quote against bytes this process read.
  const pages = new Map<string, RetrievedPage>();
  for (const p of opts.retrieved ?? []) pages.set(p.url, p);
  const log: Array<{ url: string; ok: boolean; reason: string }> = [];
  if (opts.reader) {
    const urls = [...new Set(reads.filter((r) => isOfficialSourceHost(r.sourceUrl, hosts) && !pages.has(r.sourceUrl)).map((r) => r.sourceUrl))];
    for (const url of urls.slice(0, UTILITY_REQUIREMENTS_CONFIRM_MAX_READS)) {
      try {
        const page = await opts.reader.read(url);
        log.push({ url, ok: page.ok, reason: str(page.reason).slice(0, 160) });
        if (page.ok && page.text) pages.set(url, { url, text: page.text, fetchedAt: nowIso() });
      } catch (err) {
        log.push({ url, ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
      }
    }
  }
  if (log.length) out.pagesRead = log;

  const shipped = shippedRecordFor(where.state, where.utility);
  const at = opts.at && /^\d{4}-\d{2}-\d{2}T/.test(opts.at) ? opts.at : nowIso();
  const next = [...onRow];
  for (const r of reads) {
    const page = pages.get(r.sourceUrl);
    // The item-naming check is QUOTE_NAMES_REQUIREMENT (utilityRequirementReadsOf); the landing checks the
    // host, the fetched-at time and that the quote is in the bytes read (the quote is its own "value").
    const land = landingTierFor({ sourceUrl: r.sourceUrl, quote: r.quote, value: r.quote, ...(page ? { fetchedAt: page.fetchedAt, retrievedText: page.text } : {}), verifiedAuthorityHosts: hosts });
    const official = land.tier === "official";
    const item: UtilityApplicationRequirement = {
      key: r.key,
      whenMissing: official && MANDATORY.test(r.quote) ? "blocker" : "warning",
      tier: official ? "official" : "seeded",
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl,
      quote: r.quote,
      fetchedAt: page?.fetchedAt ?? at,
    };
    const i = next.findIndex((x) => x.key === r.key);
    const held = i >= 0 ? next[i] : null;
    if (held?.tier === "verified") {
      if (official && held.whenMissing !== item.whenMissing) {
        const c = { key: r.key, current: held.whenMissing, found: item.whenMissing, sourceUrl: r.sourceUrl, quote: r.quote.slice(0, 240) };
        const fp = `${utilityFilingKey(where.state, where.utility)}|${r.key}|${held.whenMissing}|${item.whenMissing}|${land.host}`;
        const seen = db.get<{ id: string }>("SELECT id FROM audit_logs WHERE action = ? AND details LIKE ? LIMIT 1", [CONFLICT_ACTION, `%"fingerprint":${JSON.stringify(fp)}%`]);
        if (!seen) {
          addAuditLog(db, null, "system", ACTOR, CONFLICT_ACTION, { state: where.state, utility: where.utility, ...c, fingerprint: fp });
          logger.warn("utility-requirements", `${where.utility} (${where.state}): the official page ${r.sourceUrl} reads ${r.key} as ${item.whenMissing}, a person recorded ${held.whenMissing}; kept as a conflict for a person, the row is unchanged`);
        }
        out.conflicts.push(c);
      }
      out.skipped.push(`${r.key} (a person recorded it)`);
      continue;
    }
    if (held?.tier === "official") {
      if (!official) { out.skipped.push(`${r.key} (an official read is on file from ${sourceHostOf(held.sourceUrl)})`); continue; }
      if (sourceHostOf(held.sourceUrl) !== land.host) { out.skipped.push(`${r.key} (an official read is on file from ${sourceHostOf(held.sourceUrl)})`); continue; }
    }
    if (!official && !held && shipped?.requirements.some((x) => x.key === r.key)) { out.skipped.push(`${r.key} (the shipped reference covers it)`); continue; }
    if (i >= 0) next[i] = item; else next.push(item);
    out.landed.push(`${r.key} (${item.tier})`);
  }
  if (!out.landed.length) return { ...out, reason: out.conflicts.length ? "kept as a conflict for a person" : "nothing new to land" };
  db.run("UPDATE utility_filing_lookups SET application_requirements_json = ? WHERE profile_key = ?", [JSON.stringify({ requirements: next }), utilityFilingKey(where.state, where.utility)]);
  addAuditLog(db, null, "system", ACTOR, "utility_filing.application_requirements_researched", { state: where.state, utility: where.utility, landed: out.landed, skipped: out.skipped });
  return { ...out, saved: true, reason: "landed" };
}
