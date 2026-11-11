// ---------------------------------------------------------------------------
// PROPOSED FILING DESTINATIONS, CONFIRMED BY ONE CLICK (owner, 2026-11-10).
//
// The owner's decision: where a filing is SENT (a permit portal's address, a utility's portal, an
// email address, "filed inside the city's permit") stays a PERSON's fact and is never trusted
// automatically (CLAUDE.md rule 3's last sentence, rule 1, rule 5's carve-out). But the bot already
// read most of these on the authority's own official page, with the page's words. So Keelix
// PRE-FILLS a proposed destination from that page — the address, the page link and its verbatim
// words — and a staff member confirms it with one click, once per city or utility. Editing it or
// rejecting it is one click too.
//
// WHAT A PROPOSAL IS, AND IS NOT:
//   · It is COMPUTED on read from rows already on file, and stored NOWHERE. No table, column or
//     cache holds a proposed address, so nothing that decides a channel, stages a run, launches a
//     portal or sends an email can read one: channelResolution / utilityTrackPresentation /
//     filingEmailChannelFor / the stage read only the person-verified records below. Only server.ts's
//     filing-destination routes import this module (pinned by filingDestinationProposals.test).
//   · It comes ONLY from a row that carries an http(s) source page, a verbatim quote and a fetched-at
//     time (anything less is listed under `skipped` with why). One-click CONFIRM is offered only when
//     that page is on the authority's own OFFICIAL host (shared/src/officialSource.citationShortfalls —
//     a government host, or a domain a person verified as the authority's own); a cited page off that
//     host (a utility's .com) is shown for Edit only, where the person states it as their own check.
//   · Its sources: an AHJ's reference process profile citations (field "submissionMethod", the value
//     read), the AHJ's per-job permit-process lookup (a permit's cited portal, or the email address
//     its cited filing channel gives), and the utility's
//     filing lookup (its cited portal, a with-permit method, or an email address in its words), and the
//     utility's shipped cited door (utilityRequirements `filingDoor`, seeded into its KB row). A NEM
//     destination is NEVER taken from an AHJ's row (rule 5: never the AHJ's row for the NEM track).
//   · ONE EXCEPTION TO "CITED ONLY", FOR EDIT ONLY (soft run on main f280d056): a utility whose only
//     door is its SEEDED knowledge-base row with no page words (the address the NEM track card already
//     shows as "seeded knowledge base — verify") is offered as a proposal marked `seeded`, so the queue
//     no longer hides it. It is NEVER a one-click Confirm (decideFilingDestination refuses it by its
//     mark, whatever its problems say): a person opens the utility's page and uses Edit, stating the
//     page and its words as their own check, through the same refusals as every door. A seeded address
//     those refusals would turn away (rule 5, an information page) is listed under `skipped`, not offered.
//
// WHAT CONFIRMING WRITES — THE EXISTING PERSON-VERIFIED RECORD, NOTHING NEW:
//   · a permit portal  → saveVerifiedAhjProfile (verified permit_utility_knowledge row, portal_url);
//   · a utility portal → saveVerifiedUtilityProfile (same, the utility's row);
//   · an email address → filingEmail.setFilingEmail (filing_email_json on the authority's lookup row);
//   · with the permit  → utilityFilingLookup.verifyUtilityFilingLookup with the with-permit statement.
//   Each with the named person (verified_by) and the time (verified_at), and an audit row on the job.
//   The same fit checks the manual doors run (rule 5's hostFitsTrackAndEntity through
//   assertOperatorPortalUrlFits, the information-page refusal, the filing-email record rules) run
//   before the write, and on the read too, so a proposal that would be refused says why and cannot
//   be confirmed. Whether automation may then FILE is still rule 1's gate, unchanged.
//
// Universal: reads whatever authority the job names. No state, city, utility or portal is named here.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import type { AhjProcessProfile, ProjectRecord, SubmittalTrackType } from "../../shared/src/types";
import { citationShortfalls, quoteText, siteOfHost, sourceHostOf } from "../../shared/src/officialSource";
import type { AppDb } from "./db";
import { addAuditLog } from "./audit";
import { nowIso } from "./time";
import { authorityForTrack, filingEmailRecordProblems, readFilingEmail, setFilingEmail, type FilingAuthority } from "./filingEmail";
import { getPermitProcessLookup, projectForTrack } from "./permitProcess";
import { findAhjProcessProfile } from "./processProfiles";
import { separateCounterFor } from "./ahjRowCitations";
import { personVerifiedAuthorityHosts } from "./officialAuthorityHosts";
import { FILED_WITH_AHJ_PERMIT, getUtilityFilingLookup, utilityTrackPresentation, verifyUtilityFilingLookup } from "./utilityFilingLookup";
import { shippedRecordFor, utilityPersonVerifiedHosts } from "./utilityRequirements";
import { hostFitsTrackAndEntity, isInformationalPageUrl, trackSafeUrl } from "./portalChannel";
import { assertOperatorPortalUrlFits, portalEntityEvidence } from "./portalRecipes";
import { saveVerifiedAhjProfile, saveVerifiedUtilityProfile } from "./knowledgeBase";
import { mapProject } from "./repository";
import { handCheckPages, handCheckPagesFor, type HandCheckPage } from "./handCheckPages";
import { serviceAreaAuthorities, type ClientServiceAreaEntry, type ServiceAreaAuthority } from "./clientServiceArea";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export type DestinationKind = "portal" | "email" | "with_permit";
export type DestinationSource = "reference" | "permit_lookup" | "utility_lookup" | "seeded_kb";

export interface DestinationProposal {
  /** A fingerprint of the authority, kind, address, page and words: a changed source is a new proposal. */
  id: string;
  kind: DestinationKind;
  /** The portal URL or the email address; "" for "filed with the permit". */
  address: string;
  /** with_permit: the permit application it rides in, as the row names it. */
  name?: string;
  sourceUrl: string;
  sourceHost: string;
  /** The page's own words, verbatim as the row carries them. */
  quote: string;
  fetchedAt: string;
  from: DestinationSource;
  /** The page is on the authority's own OFFICIAL host (officialSource.citationShortfalls). When it is not
   *  (a utility's .com nobody has verified as its own), the proposal is shown for Edit only: Confirm is
   *  refused and a person states it as their own check. */
  official: boolean;
  /** The words contain the address (else the address is the link behind the words: open the page). */
  quoteNamesAddress: boolean;
  /** Why Confirm would be refused right now; empty = one click confirms it. */
  problems: string[];
  /** The address is the utility's SEEDED knowledge-base row, with no page words on file (from
   *  "seeded_kb"; quote and fetchedAt are empty, sourceUrl is the page the row names or ""). Edit only:
   *  Confirm is always refused, and nothing files or sends to it until a named person states it. */
  seeded?: true;
}

export interface AuthorityDestinations {
  authority: { kind: "ahj" | "utility"; name: string; state: string; profileKey: string };
  /** The job's tracks that file with this authority. */
  tracks: SubmittalTrackType[];
  /** verified: a person's record already says where these tracks file (no proposal is offered). */
  status: "verified" | "proposed" | "none";
  /** The verified destination in words, when status is verified. */
  verified?: string;
  proposals: DestinationProposal[];
  rejected: Array<{ id: string; kind: string; address: string; rejectedBy: string; rejectedAt: string; reason: string }>;
  /** Candidates that were NOT proposed, and why (not an official page, no words, no read time). */
  skipped: string[];
}

/** A cited door candidate, before the official-page test. */
interface Candidate {
  kind: DestinationKind;
  address: string;
  name?: string;
  sourceUrl: string;
  quote: string;
  fetchedAt: string;
  from: DestinationSource;
  /** A seeded knowledge-base address with no citation (seededUtilityDoorCandidates): Edit only. */
  seeded?: true;
}

const EMAIL_IN_TEXT = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}/gi;

/** A scheme-less value ("permits.example.gov/apply") as an https URL; "" when it is not a URL. */
export function addressAsUrl(value: string): string {
  const v = str(value).replace(/[).,;]+$/, "");
  if (!v || /\s/.test(v)) return "";
  const withScheme = /^https?:\/\//i.test(v) ? v : /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]\S*)?$/i.test(v) ? `https://${v}` : "";
  if (!withScheme) return "";
  try { return new URL(withScheme).hostname.includes(".") ? withScheme : ""; } catch { return ""; }
}

export function proposalId(authorityKey: string, c: Pick<Candidate, "kind" | "address" | "sourceUrl" | "quote">): string {
  return crypto.createHash("sha256").update([authorityKey, c.kind, c.address.toLowerCase(), c.sourceUrl, quoteText(c.quote)].join("\u0000")).digest("hex").slice(0, 24);
}

function quoteNames(kind: DestinationKind, address: string, quote: string): boolean {
  const q = quoteText(quote).toLowerCase();
  if (kind === "with_permit") return true;
  if (kind === "email") return q.includes(address.toLowerCase());
  const host = sourceHostOf(address);
  return !!host && q.includes(host.replace(/^www\./, ""));
}

/** Citations on a reference process profile (the optional `citations` evidence field), read
 *  structurally so this works whether or not the shared type declares it yet. */
function profileCitations(profile: AhjProcessProfile | null): Array<{ field: string; value: string; sourceUrl: string; quote: string; fetchedAt: string }> {
  const raw = (profile as unknown as { citations?: unknown } | null)?.citations;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({ field: str(c.field), value: str(c.value), sourceUrl: str(c.sourceUrl), quote: str(c.quote), fetchedAt: str(c.fetchedAt) }));
}

/** Which of a permit lookup's permits answer for a track. */
function disciplinesFor(track: SubmittalTrackType): string[] {
  if (track === "building") return ["structural", "combo"];
  if (track === "electrical") return ["electrical", "combo"];
  return ["combo", "structural", "electrical", "other"];
}

/** Every cited door candidate for an AHJ (permit side). Pure over the rows it is handed. */
export function permitCandidates(input: {
  profile: AhjProcessProfile | null;
  lookup: ReturnType<typeof getPermitProcessLookup>;
  tracks: SubmittalTrackType[];
}): Candidate[] {
  const out: Candidate[] = [];
  for (const c of profileCitations(input.profile)) {
    if (c.field !== "submissionMethod") continue;
    const url = addressAsUrl(c.value);
    if (url) out.push({ kind: "portal", address: url, sourceUrl: c.sourceUrl, quote: c.quote, fetchedAt: c.fetchedAt, from: "reference" });
    for (const email of c.quote.match(EMAIL_IN_TEXT) ?? []) {
      out.push({ kind: "email", address: email.toLowerCase(), sourceUrl: c.sourceUrl, quote: c.quote, fetchedAt: c.fetchedAt, from: "reference" });
    }
  }
  const lookup = input.lookup;
  if (lookup && lookup.confidence !== "verified") {
    const wanted = new Set(input.tracks.flatMap(disciplinesFor));
    for (const p of lookup.permits ?? []) {
      if (!wanted.has(str(p.discipline))) continue;
      const url = addressAsUrl(str(p.portalUrl?.value));
      if (url) out.push({ kind: "portal", address: url, sourceUrl: str(p.portalUrl.sourceUrl), quote: str(p.portalUrl.quote), fetchedAt: str(lookup.lookedUpAt), from: "permit_lookup" });
      // THE PERMIT'S CITED EMAIL CHANNEL (lookup-permit-filing-channel): an address the page gives for
      // filing this permit becomes a PROPOSAL only — confirming it writes the filing-email record
      // (setFilingEmail) like any other email proposal; nothing sends to it until rule 1's gate.
      for (const c of [p.channel, ...(p.alternateChannels ?? [])]) {
        const v = c?.value;
        if (!v || v.kind !== "email" || !v.value) continue;
        out.push({ kind: "email", address: v.value.toLowerCase(), sourceUrl: str(c!.sourceUrl), quote: str(c!.quote), fetchedAt: str(lookup.lookedUpAt), from: "permit_lookup" });
      }
    }
  }
  return out;
}

/** Every cited door candidate for a utility (NEM side): its own filing lookup only, never an AHJ's row. */
export function utilityCandidates(lookup: ReturnType<typeof getUtilityFilingLookup>): Candidate[] {
  if (!lookup || lookup.confidence === "verified") return [];
  const f = lookup.filing;
  const v = f?.value;
  if (!v) return [];
  const base = { sourceUrl: str(f.sourceUrl), quote: str(f.quote), fetchedAt: str(lookup.lookedUpAt), from: "utility_lookup" as const };
  const out: Candidate[] = [];
  if (v.method === FILED_WITH_AHJ_PERMIT) out.push({ ...base, kind: "with_permit", address: "", name: str(v.name) || "AHJ permit application" });
  else {
    const url = addressAsUrl(str(v.url));
    if (url) out.push({ ...base, kind: "portal", address: url });
    for (const email of str(f.quote).match(EMAIL_IN_TEXT) ?? []) out.push({ ...base, kind: "email", address: email.toLowerCase() });
  }
  return out;
}

/** The utility's shipped, cited filing door (reference-utility-application-requirements.json
 *  `filingDoor`, seeded into its KB row at boot): a candidate like any other, never a verified door. */
export function shippedDoorCandidates(state: string, utility: string): Candidate[] {
  let door;
  try { door = shippedRecordFor(state, utility)?.filingDoor; } catch { door = undefined; }
  if (!door) return [];
  const url = addressAsUrl(door.url);
  return url ? [{ kind: "portal", address: url, name: door.name, sourceUrl: door.sourceUrl, quote: door.quote, fetchedAt: door.fetchedAt, from: "reference" }] : [];
}

/**
 * THE UTILITY'S SEEDED KNOWLEDGE-BASE DOOR, exactly as the NEM track card shows it
 * (utilityTrackPresentation's `seededDoor`: the row's portal address, already through rule 5's
 * hostFitsTrackAndEntity; absent once a person verified a door, or when a cited lookup names one).
 * It carries no page words and no read time, so it can never be confirmed by one click: it is offered
 * for Edit only, with the page the row names (if any) pre-filled for the person to open. Reads only.
 */
export function seededUtilityDoorCandidates(db: AppDb, state: string, utility: string): Candidate[] {
  let door;
  try { door = utilityTrackPresentation(db, { state, utility }).seededDoor; } catch { door = undefined; }
  if (!door) return [];
  const url = addressAsUrl(door.url);
  if (!url) return [];
  const page = /^https?:\/\/\S+$/i.test(str(door.source)) ? str(door.source) : "";
  return [{ kind: "portal", address: url, name: door.name, sourceUrl: page, quote: "", fetchedAt: "", from: "seeded_kb", seeded: true }];
}

/** Two portal addresses that are the same door (case and a trailing slash aside). */
const sameDoor = (address: string): string => str(address).toLowerCase().replace(/\/+$/, "");

/** The words do not contain the address: the one shortfall that does NOT stop a proposal (an official
 *  page usually links its portal from words like "Apply online"). It is shown on the card instead. */
const QUOTE_LACKS_VALUE = "the quote does not contain the value";
/** citationShortfalls' host reason: the page is not on the authority's own official host. */
const OFFICIAL_HOST_SHORTFALL = /is not a government host or a domain a person verified/;

/**
 * Why a candidate is not proposed at all (empty = it is): the ONE citation test every official-source
 * reader uses (shared/src/officialSource.citationShortfalls — the authority's own official host, a
 * verbatim quote, a fetched-at time). Whether the quote contains the address is answered separately
 * (quoteNamesAddress) and shown; it never makes a proposal confirmable without a person.
 */
export function candidateSkipReasons(c: Candidate, verifiedAuthorityHosts: readonly string[]): string[] {
  const { reasons } = citationShortfalls({
    sourceUrl: c.sourceUrl, quote: c.quote, fetchedAt: c.fetchedAt, verifiedAuthorityHosts,
    quoteStatesValue: (q) => quoteNames(c.kind, c.address, q),
  });
  return reasons.filter((r) => r !== QUOTE_LACKS_VALUE);
}

/** Words in an authority's name that say what KIND of body it is, not WHICH one ("City of", "Power"). */
const GENERIC_NAME_WORDS = new Set(["city", "town", "village", "county", "borough", "township", "of", "the", "and", "department",
  "power", "light", "electric", "electrical", "energy", "utility", "utilities", "municipal", "public", "district", "cooperative", "coop"]);

/**
 * A SHARED PLATFORM'S BARE HOST IS NOT A CITY'S PORTAL. A proposed portal off the authority's own site
 * (a vendor's host) must show WHOSE tenant it is: a path ("/application/<id>", "/SLCREF") or a host
 * label that names the authority ("<city>.vendor.com"). A bare vendor host that many cities share
 * ("<region>.vendor.com") says nothing about which city files there, so Confirm is refused and Edit
 * asks for the city's own link. "" when the address shows its tenant. Pure.
 */
export function bareSharedHostProblem(address: string, authorityName: string, sourceUrl: string): string {
  let u: URL;
  try { u = new URL(address); } catch { return ""; }
  const host = u.hostname.toLowerCase();
  if (siteOfHost(host) === siteOfHost(sourceHostOf(sourceUrl))) return "";
  if (u.pathname.replace(/\/+$/, "") || u.search) return "";
  const tokens = str(authorityName).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC_NAME_WORDS.has(t));
  const hostWords = host.replace(/\./g, " ");
  if (tokens.some((t) => hostWords.includes(t))) return "";
  return `${host} is a shared platform's address that does not show ${authorityName}'s own tenant (no path, and the host does not name it): use Edit with ${authorityName}'s own link (its registration link or application address)`;
}

/** Why confirming would be refused now (empty = confirmable). Reads only. */
function confirmProblems(db: AppDb, authority: FilingAuthority, track: SubmittalTrackType, c: Candidate): string[] {
  const out: string[] = [];
  if (c.kind === "portal") {
    const t = authority.kind === "utility" ? "nem" : track;
    if (!trackSafeUrl(t, c.address)) out.push(authority.kind === "utility" ? "this is a permit portal, not a utility's (rule 5)" : "this is a utility interconnection portal, not a permit portal (rule 5)");
    else if (isInformationalPageUrl(c.address)) out.push("this address is an information page, not an application portal");
    else if (bareSharedHostProblem(c.address, authority.name, c.sourceUrl)) out.push(bareSharedHostProblem(c.address, authority.name, c.sourceUrl));
    else {
      try {
        const entity = portalEntityEvidence(db, { scope: authority.kind === "utility" ? "utility" : "ahj", state: authority.state, name: authority.name });
        const fit = hostFitsTrackAndEntity(t, entity, c.address, "operator");
        if (!fit.fits) out.push(fit.reason);
      } catch (err) { out.push(`the portal fit check could not run: ${err instanceof Error ? err.message : String(err)}`); }
    }
  } else if (c.kind === "email") {
    out.push(...filingEmailRecordProblems({ address: c.address, sourceUrl: c.sourceUrl, quote: c.quote, verifiedBy: "check", verifiedAt: "check" }));
    if (!readFilingEmail(db, authority).rowExists) out.push(`no ${authority.kind === "utility" ? "utility filing lookup" : "permit process lookup"} is on file for ${authority.name} yet: run its lookup first, the email record lives on that row`);
  } else if (c.kind === "with_permit") {
    if (authority.kind !== "utility") out.push("only a utility's application rides inside a permit");
    if (quoteText(c.quote).length < 8) out.push("a with-permit statement carries the page's own words");
  }
  return out;
}

function rejectionsFor(db: AppDb, profileKey: string, kind: string): AuthorityDestinations["rejected"] {
  try {
    return db.query<Record<string, unknown>>(
      "SELECT proposal_id, kind, address, rejected_by, rejected_at, reason FROM filing_destination_rejections WHERE authority_kind = ? AND profile_key = ? ORDER BY rejected_at DESC",
      [kind, profileKey],
    ).map((r) => ({ id: str(r.proposal_id), kind: str(r.kind), address: str(r.address), rejectedBy: str(r.rejected_by), rejectedAt: str(r.rejected_at), reason: str(r.reason) }));
  } catch { return []; }
}

/** The verified destination in words, or "" — a person's record only (the same records confirming writes). */
function verifiedDestination(db: AppDb, authority: FilingAuthority, trackViews: Array<{ type: SubmittalTrackType; channel?: string; channelBasis?: string }>): string {
  const email = readFilingEmail(db, authority).record;
  if (email && !filingEmailRecordProblems(email).length) return `Email ${email.address} (verified by ${email.verifiedBy})`;
  const v = trackViews.find((t) => t.channelBasis === "verified");
  return v ? str(v.channel) : "";
}

/**
 * THE JOB'S FILING DESTINATIONS, PER AUTHORITY. Reads only: nothing is written, nothing is cached.
 * `trackViews` are the job's tracks as getSubmittalTracks resolved them (type, channel, basis).
 */
export function filingDestinationsFor(
  db: AppDb,
  project: ProjectRecord,
  trackViews: Array<{ type: SubmittalTrackType; channel?: string; channelBasis?: string }>,
): AuthorityDestinations[] {
  const groups = new Map<string, { authority: FilingAuthority; tracks: SubmittalTrackType[]; views: typeof trackViews }>();
  for (const t of trackViews) {
    // A track filed at ANOTHER COUNTER of the same AHJ (ahjRowCitations.separateCounterFor) is not
    // filed where the AHJ's door goes: confirming the AHJ's portal must not read as confirming it, so it
    // joins no authority's group here. Its door is the counter its card names, and stays unverified.
    if (t.type !== "nem" && separateCounterFor(projectForTrack(project, t.type), t.type)) continue;
    const a = authorityForTrack(project, t.type);
    if (!a) continue;
    const key = `${a.kind}|${a.profileKey}`;
    const g = groups.get(key) ?? { authority: a, tracks: [], views: [] };
    g.tracks.push(t.type);
    g.views.push(t);
    groups.set(key, g);
  }
  const out: AuthorityDestinations[] = [];
  for (const { authority, tracks, views } of groups.values()) {
    const head = { kind: authority.kind, name: authority.name, state: authority.state, profileKey: authority.profileKey };
    const rejected = rejectionsFor(db, authority.profileKey, authority.kind);
    const verified = verifiedDestination(db, authority, views);
    if (verified) {
      out.push({ authority: head, tracks, status: "verified", verified, proposals: [], rejected, skipped: [] });
      continue;
    }
    let candidates: Candidate[];
    let hosts: string[];
    if (authority.kind === "utility") {
      candidates = [...utilityCandidates(getUtilityFilingLookup(db, authority.state, authority.name)), ...shippedDoorCandidates(authority.state, authority.name)];
      // The seeded KB door LAST: a cited candidate naming the same address is the one shown (below).
      candidates.push(...seededUtilityDoorCandidates(db, authority.state, authority.name));
      try { hosts = utilityPersonVerifiedHosts(db, authority.state, authority.name); } catch { hosts = []; }
    } else {
      const issuer = projectForTrack(project, tracks[0]);
      candidates = permitCandidates({ profile: findAhjProcessProfile(issuer), lookup: getPermitProcessLookup(db, authority.state, authority.name), tracks });
      try { hosts = personVerifiedAuthorityHosts(db, authority.state, authority.name); } catch { hosts = []; }
    }
    const rejectedIds = new Set(rejected.map((r) => r.id));
    const proposals: DestinationProposal[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    // Portal addresses a CITED candidate already answers for: proposed with its page and words, or
    // rejected by a person. The seeded twin of the same address is not offered beside or after it.
    const citedDoors = new Set<string>();
    for (const c of candidates) {
      const id = proposalId(authority.profileKey, c);
      if (seen.has(id)) continue;
      seen.add(id);
      const label = c.kind === "with_permit" ? "filed with the permit" : c.address;
      if (c.seeded) {
        if (citedDoors.has(sameDoor(c.address))) continue;
        // SEEDED, NO CITATION: it goes through the same citation test as every candidate
        // (candidateSkipReasons) and always falls short of it (no page words, no read time): those
        // shortfalls are why it is Edit only. It is offered only when the same refusals every door
        // meets (rule 5's hostFitsTrackAndEntity, the information-page refusal) would let a person save it.
        const shortfalls = candidateSkipReasons(c, hosts);
        const refusals = confirmProblems(db, authority, tracks[0], c);
        if (refusals.length) { skipped.push(`${label} (seeded knowledge base, no page words on file): ${refusals.join("; ")}`); continue; }
        if (rejectedIds.has(id)) continue;
        proposals.push({
          id, kind: c.kind, address: c.address, ...(c.name ? { name: c.name } : {}),
          sourceUrl: c.sourceUrl, sourceHost: sourceHostOf(c.sourceUrl), quote: "", fetchedAt: "", from: c.from,
          official: false, quoteNamesAddress: false, seeded: true,
          problems: [`this address is a seeded knowledge-base entry with no page words on file (${shortfalls.join("; ") || "never cited"}), so one-click Confirm is never offered: open ${authority.name}'s own application page, check the address, then use Edit to record the page and its words as your own check`],
        });
        continue;
      }
      const skip = candidateSkipReasons(c, hosts);
      // A page off the authority's official host, with its words and read time, is still shown — for
      // Edit only (a person states it as their own check); a row missing its words or time is not.
      const notHost = skip.filter((r) => !OFFICIAL_HOST_SHORTFALL.test(r));
      if (notHost.length) { skipped.push(`${label} (${c.sourceUrl || "no page"}): ${skip.join("; ")}`); continue; }
      if (c.kind === "portal") citedDoors.add(sameDoor(c.address));
      if (rejectedIds.has(id)) continue;
      const official = skip.length === 0;
      proposals.push({
        id, kind: c.kind, address: c.address, ...(c.name ? { name: c.name } : {}),
        sourceUrl: c.sourceUrl, sourceHost: sourceHostOf(c.sourceUrl), quote: c.quote, fetchedAt: c.fetchedAt, from: c.from,
        official,
        quoteNamesAddress: quoteNames(c.kind, c.address, c.quote),
        problems: [
          ...(official ? [] : [`${sourceHostOf(c.sourceUrl)} is not a government host or a domain a person verified as ${authority.name}'s own, so one-click Confirm is not offered: open the page, then use Edit to record it as your own check`]),
          ...confirmProblems(db, authority, tracks[0], c),
        ],
      });
    }
    out.push({ authority: head, tracks, status: proposals.length ? "proposed" : "none", proposals, rejected, skipped });
  }
  return out;
}

// ── A PERSON'S DECISION ────────────────────────────────────────────────────────────────────────

export interface DestinationDecision {
  track: SubmittalTrackType;
  /** The proposal the person saw (Confirm). Absent, or naming nothing current, = a person's own statement (Edit). */
  proposalId?: string;
  kind: DestinationKind;
  address: string;
  name?: string;
  sourceUrl: string;
  quote: string;
}

export class DestinationRefused extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** One segment of a KB note: the record's own " | " separator never appears inside it. */
const noteSegment = (s: string): string => str(s).replace(/\s*\|\s*/g, " / ").slice(0, 400);

/**
 * CONFIRM A PROPOSAL, OR STATE AN EDITED DESTINATION, AS A NAMED PERSON. Writes the existing
 * person-verified record for the kind and audits it on the job. A Confirm must name a proposal
 * that is still current and confirmable, with exactly the address, page and words shown (the server
 * re-derives it; a stale or altered click is refused, not re-read as an edit). An Edit (no proposal)
 * is the person's own statement: it carries its page and the page's words, and passes the same
 * fit checks as every manual door. `verifiedBy` is already a named person (server.namedPersonDecider).
 */
export function decideFilingDestination(
  db: AppDb,
  project: ProjectRecord,
  trackViews: Array<{ type: SubmittalTrackType; channel?: string; channelBasis?: string }>,
  decision: DestinationDecision,
  verifiedBy: string,
): { action: "confirmed" | "stated"; authority: AuthorityDestinations["authority"]; kind: DestinationKind; address: string } {
  const who = str(verifiedBy).slice(0, 120);
  if (!who) throw new DestinationRefused(400, "A filing destination is confirmed by a named person.");
  if (!trackViews.some((t) => t.type === decision.track)) throw new DestinationRefused(400, `This job has no ${decision.track} track.`);
  // A track filed at ANOTHER COUNTER of the same AHJ: the AHJ's door is not its destination, so a
  // destination recorded "for" it would only ever be the AHJ's (where its building permit files).
  const counter = decision.track !== "nem" ? separateCounterFor(projectForTrack(project, decision.track), decision.track) : null;
  if (counter) throw new DestinationRefused(409, `The ${decision.track} permit here is filed at a separate counter (${counter.value}), per the AHJ's own page: it has no portal or address of the AHJ's to confirm. A person files it there.`);
  const authority = authorityForTrack(project, decision.track);
  if (!authority) throw new DestinationRefused(400, "This track names no authority to file with.");
  const kind = decision.kind;
  if (!["portal", "email", "with_permit"].includes(kind)) throw new DestinationRefused(400, "kind is portal, email or with_permit.");
  const sourceUrl = str(decision.sourceUrl).slice(0, 600);
  const quote = str(decision.quote).slice(0, 600);
  let address = kind === "email" ? str(decision.address).toLowerCase() : kind === "portal" ? addressAsUrl(decision.address) : "";
  if (kind === "portal" && !address) throw new DestinationRefused(400, `"${str(decision.address).slice(0, 200)}" is not a portal address.`);

  let action: "confirmed" | "stated" = "stated";
  if (str(decision.proposalId)) {
    const group = filingDestinationsFor(db, project, trackViews).find((g) => g.authority.kind === authority.kind && g.authority.profileKey === authority.profileKey);
    const p = group?.proposals.find((x) => x.id === str(decision.proposalId));
    if (!p) throw new DestinationRefused(409, "That proposal is no longer current (the source changed, it was rejected, or a person already recorded this authority's destination). Reload and look again.");
    // A SEEDED ADDRESS IS NEVER CONFIRMED BY ONE CLICK, by its mark (not only by its problems text).
    if (p.seeded) throw new DestinationRefused(409, "A seeded address has no page words on file, so it cannot be confirmed by one click. Open the authority's own page, then use Edit to record the page and its words as your own check.");
    if (p.kind !== kind || p.address !== address || p.sourceUrl !== sourceUrl || quoteText(p.quote) !== quoteText(quote)) {
      throw new DestinationRefused(409, "What was sent is not the proposal shown. Reload, or use Edit to state a different destination.");
    }
    if (p.problems.length) throw new DestinationRefused(409, `This proposal cannot be confirmed: ${p.problems.join("; ")}`);
    action = "confirmed";
  } else {
    // A PERSON'S OWN STATEMENT: the page they read it on and its words, like every manual door.
    if (!/^https?:\/\/\S+$/i.test(sourceUrl) || !sourceHostOf(sourceUrl)) throw new DestinationRefused(400, "Say which http(s) page you read this destination on.");
    if (quoteText(quote).length < 8) throw new DestinationRefused(400, "Copy the page's own words that say where applications go.");
  }

  const fromNote = `Filing destination ${action} by ${who} from ${sourceUrl}: "${noteSegment(quote)}"`;
  if (kind === "portal") {
    const t = authority.kind === "utility" ? "nem" : decision.track;
    if (!trackSafeUrl(t, address)) throw new DestinationRefused(409, `${address} belongs on the ${authority.kind === "utility" ? "AHJ's permit" : "utility's interconnection"} track, not this one (rule 5).`);
    if (isInformationalPageUrl(address)) throw new DestinationRefused(409, `${address} is an information page, not an application portal.`);
    try {
      assertOperatorPortalUrlFits(db, { track: t, state: authority.state, name: authority.name, url: address });
    } catch (err) {
      throw new DestinationRefused(409, err instanceof Error ? err.message : String(err));
    }
    if (authority.kind === "utility") saveVerifiedUtilityProfile(db, { state: authority.state, utility: authority.name, portalUrl: address, notes: fromNote, verifiedBy: who });
    else saveVerifiedAhjProfile(db, { state: authority.state, ahj: authority.name, portalUrl: address, notes: fromNote, verifiedBy: who });
  } else if (kind === "email") {
    const r = setFilingEmail(db, authority, { address, sourceUrl, quote }, who);
    if (!r.saved) throw new DestinationRefused(r.problems.length ? 400 : 409, r.reason);
  } else {
    if (authority.kind !== "utility") throw new DestinationRefused(400, "Only a utility's application rides inside a permit.");
    const r = verifyUtilityFilingLookup(db, { state: authority.state, utility: authority.name }, {
      verifiedBy: who, filedWithPermit: { name: str(decision.name).slice(0, 160) || "AHJ permit application", sourceUrl, quote },
    });
    if (!r.saved) throw new DestinationRefused(r.lookup ? 409 : 400, r.reason);
    address = "";
  }
  const audit = auditTarget(project);
  addAuditLog(db, audit.projectId, "human", who, `filing_destination.${action}`, {
    authorityKind: authority.kind, authority: authority.name, state: authority.state, track: decision.track,
    kind, address, sourceUrl, ...(action === "confirmed" ? { proposalId: str(decision.proposalId) } : {}), ...audit.extra,
  });
  return { action, authority: { kind: authority.kind, name: authority.name, state: authority.state, profileKey: authority.profileKey }, kind, address };
}

/** REJECT A PROPOSAL (a named person): it stops being offered for this authority until its source
 *  changes (a new page or new words make a new proposal). Shared like the authority's rows. */
export function rejectFilingDestination(
  db: AppDb,
  project: ProjectRecord,
  trackViews: Array<{ type: SubmittalTrackType; channel?: string; channelBasis?: string }>,
  input: { track: SubmittalTrackType; proposalId: string; reason?: string },
  rejectedBy: string,
): { rejected: true; proposalId: string } {
  const who = str(rejectedBy).slice(0, 120);
  if (!who) throw new DestinationRefused(400, "A proposal is rejected by a named person.");
  const authority = authorityForTrack(project, input.track);
  if (!authority || !trackViews.some((t) => t.type === input.track)) throw new DestinationRefused(400, `This job has no ${input.track} track to reject a destination on.`);
  const group = filingDestinationsFor(db, project, trackViews).find((g) => g.authority.kind === authority.kind && g.authority.profileKey === authority.profileKey);
  const p = group?.proposals.find((x) => x.id === str(input.proposalId));
  if (!p) throw new DestinationRefused(409, "That proposal is no longer current. Reload and look again.");
  const reason = str(input.reason).slice(0, 300);
  db.run(
    `INSERT INTO filing_destination_rejections (proposal_id, authority_kind, profile_key, state, authority, kind, address, source_url, reason, rejected_by, rejected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(proposal_id) DO UPDATE SET reason = excluded.reason, rejected_by = excluded.rejected_by, rejected_at = excluded.rejected_at`,
    [p.id, authority.kind, authority.profileKey, authority.state, authority.name, p.kind, p.address, p.sourceUrl, reason, who, nowIso()],
  );
  const audit = auditTarget(project);
  addAuditLog(db, audit.projectId, "human", who, "filing_destination.rejected", {
    authorityKind: authority.kind, authority: authority.name, state: authority.state, track: input.track, kind: p.kind, address: p.address, sourceUrl: p.sourceUrl, proposalId: p.id, reason, ...audit.extra,
  });
  return { rejected: true, proposalId: p.id };
}

/** UNDO A REJECTION (a named person): the proposal is offered again. */
export function withdrawDestinationRejection(
  db: AppDb,
  project: ProjectRecord,
  input: { track: SubmittalTrackType; proposalId: string },
  by: string,
): { withdrawn: boolean } {
  const who = str(by).slice(0, 120);
  if (!who) throw new DestinationRefused(400, "A rejection is withdrawn by a named person.");
  const authority = authorityForTrack(project, input.track);
  if (!authority) throw new DestinationRefused(400, "This track names no authority.");
  const row = db.get<Record<string, unknown>>("SELECT proposal_id, kind, address FROM filing_destination_rejections WHERE proposal_id = ? AND authority_kind = ? AND profile_key = ?", [str(input.proposalId), authority.kind, authority.profileKey]);
  if (!row) return { withdrawn: false };
  db.run("DELETE FROM filing_destination_rejections WHERE proposal_id = ?", [str(input.proposalId)]);
  const audit = auditTarget(project);
  addAuditLog(db, audit.projectId, "human", who, "filing_destination.rejection_withdrawn", {
    authorityKind: authority.kind, authority: authority.name, state: authority.state, track: input.track, kind: str(row.kind), address: str(row.address), proposalId: str(input.proposalId), ...audit.extra,
  });
  return { withdrawn: true };
}

// ── THE QUEUE: EVERY AUTHORITY STILL TO CONFIRM, ACROSS THE ORG'S OPEN JOBS ─────────────────────
//
// "Destinations to confirm" (owner, 2026-11-10): since the door gate, every authority needs one named
// person's Confirm or Verify before automation may file there. The track card does that one job at a
// time; this lists, on one screen, every authority (each AHJ or per-track issuer, and each utility)
// that an open job's outstanding track files with and whose door no person has verified, grouped by
// client. Onboarding a client's ~20 authorities becomes one sitting.
//
// NOTHING NEW DECIDES OR WRITES HERE. Each authority's proposals are exactly what the job's own
// filingDestinationsFor returns (the same function the track card reads), and every proposal carries
// the job and track whose card shows it (`act`): the dashboard's Confirm / Edit / Reject send that
// job's EXISTING routes (PUT / POST / DELETE /api/projects/:id/filing-destinations), unchanged, one
// authority per named person's click. There is no bulk confirm and no new write path. Reading the queue
// writes nothing (filingDestinationQueue.test pins total_changes() and the track views), and it reads
// only the org it is handed (the route passes reqOrgFilter; rule 6).
// Universal: no state, city, utility or portal is named; hand-check pages are per-authority DATA.

export interface QueueAct { projectId: string; track: SubmittalTrackType }
/** A proposal in the queue. `act` = the open job and track whose card shows it; absent on an
 *  authority only the client's service area names (no job yet). */
export interface QueueProposal extends DestinationProposal { act?: QueueAct; areaAct?: QueueAreaAct }
/** A service-area authority's route: the client, the entry and the authority the queue shows, and the
 *  track. Its Confirm / Edit / Reject go to /api/clients/:id/service-area/filing-destinations, which
 *  runs the SAME decision functions on the entry's in-memory job and refuses a changed authority. */
export interface QueueAreaAct { clientId: string; entryKey: string; authorityKey: string; track: SubmittalTrackType }
/** An authority listed because the client's SERVICE AREA names it and none of its open jobs does. */
export interface QueueServiceArea {
  entry: ClientServiceAreaEntry;
  entryKey: string;
  /** Where the listed name came from (a name on file in that state, or the entry as typed). */
  matchedFrom: ServiceAreaAuthority["matchedFrom"];
}
export interface QueueAuthority {
  authority: AuthorityDestinations["authority"];
  /** Every outstanding track type, across the client's open jobs, that files with this authority. */
  tracks: SubmittalTrackType[];
  /** proposed: at least one proposal to Confirm or Edit; none: nothing on file to propose (Edit on a job). */
  status: "proposed" | "none";
  proposals: QueueProposal[];
  rejected: Array<AuthorityDestinations["rejected"][number] & { act?: QueueAct; areaAct?: QueueAreaAct }>;
  skipped: string[];
  /** The open jobs that wait on this authority ([] for a service-area authority). */
  jobs: Array<{ projectId: string; label: string; tracks: SubmittalTrackType[] }>;
  /** The first such job and track: where a person opens the track card to state a destination by hand.
   *  null for a service-area authority (no job names it yet). */
  open: QueueAct | null;
  /** Present when the client's service area names this authority and no open job of the client does. */
  serviceArea?: QueueServiceArea;
  /** Pages that refused an automated read for this authority (data): a person checks them by hand. */
  handCheck: HandCheckPage[];
}
export interface DestinationQueue {
  clients: Array<{ clientId: string; clientName: string; authorities: QueueAuthority[] }>;
  counts: { jobs: number; authorities: number; oneClick: number; editOnly: number; noProposal: number; handCheck: number; alreadyVerified: number; serviceArea: number };
}

// ── A CLIENT'S SERVICE AREA IN THE QUEUE (clientServiceArea.ts) ────────────────────────────────────
// An authority the client's area names is read exactly as a job's: through filingDestinationsFor on an
// IN-MEMORY job that carries only the client, the state and the one authority the entry resolved to
// (a city's AHJ, or a utility). The job is never stored (nothing here writes) and names nothing else,
// so its tracks resolve only to that authority (or the per-track issuer that authority's own data
// names, as on a real job — permitProcess.projectForTrack).
const AREA_JOB_ID_PREFIX = "service-area:";
/** serviceAreaJob's jobs, with the client and entry each was built from (a record merely shaped like
 *  one, or carrying a look-alike id, is not in here). */
const areaJobs = new WeakMap<object, { clientId: string; entryKey: string }>();

/** The in-memory job for one service-area authority. Reads nothing; stores nothing. */
export function serviceAreaJob(client: { id: string }, a: ServiceAreaAuthority): ProjectRecord {
  const now = nowIso();
  const job = mapProject({
    id: `${AREA_JOB_ID_PREFIX}${client.id}:${a.entryKey}`,
    client_id: client.id,
    homeowner_name: "", project_address: "", city: a.kind === "ahj" && a.entry.kind === "city" ? a.entry.name : "",
    state: a.state, zip: "", ahj: a.kind === "ahj" ? a.name : "", utility: a.kind === "utility" ? a.name : "",
    account_number: "", meter_number: "", system_size_dc_kw: null, system_size_ac_kw: null, total_export_kw: null,
    interconnection_method: "", status: "intake", current_stage: "intake", parser_confidence_summary: "", parser_json: "{}",
    assigned_user_id: null, created_at: now, updated_at: now, archived_at: "",
  } as never);
  areaJobs.set(job, { clientId: client.id, entryKey: a.entryKey });
  return job;
}

/** Is this one of serviceAreaJob's in-memory jobs (never a stored project)? */
export function isServiceAreaJob(project: ProjectRecord): boolean {
  return areaJobs.has(project) && project.id.startsWith(AREA_JOB_ID_PREFIX);
}

/** Where a decision is audited: the job's own row, or — for a service-area job, which is never stored —
 *  no project row, with the client and the area entry named in the details instead. */
function auditTarget(project: ProjectRecord): { projectId: string | null; extra: Record<string, unknown> } {
  const area = isServiceAreaJob(project) ? areaJobs.get(project)! : null;
  return area ? { projectId: null, extra: { serviceArea: { clientId: area.clientId, entryKey: area.entryKey } } } : { projectId: project.id, extra: {} };
}

/**
 * A DECISION FROM THE SERVICE AREA (the client-scoped twins of the per-job routes). The route names the
 * client (its scope guard has run), the area entry and the authority the queue SHOWED; this builds the
 * in-memory job for that entry and refuses unless the track it names resolves to exactly that authority.
 * The decision itself then runs through the SAME decideFilingDestination / rejectFilingDestination /
 * withdrawDestinationRejection, unchanged. Reads only.
 */
export function serviceAreaDecisionJob(
  db: AppDb,
  client: { id: string },
  input: { entryKey: string; authorityKey: string; track: SubmittalTrackType },
): ProjectRecord {
  const sa = serviceAreaAuthorities(db, client.id).find((a) => a.entryKey === str(input.entryKey));
  if (!sa) throw new DestinationRefused(404, "That place is not in this client's service area (it was removed, or never added). Reload and look again.");
  const job = serviceAreaJob(client, sa);
  const authority = authorityForTrack(job, input.track);
  const shown = str(input.authorityKey);
  if (!authority || authority.kind !== sa.kind || `${authority.kind}|${authority.profileKey}` !== shown) {
    throw new DestinationRefused(409, `This service-area entry now names ${authority ? `${authority.name} (${authority.state})` : "no authority"} on the ${input.track} track, not the one shown. Reload and look again.`);
  }
  return job;
}

/** The clients of the org that have a service area on file; `null` reads every org. Reads only. */
function clientsWithServiceArea(db: AppDb, orgId: string | null): Array<{ id: string; name: string }> {
  const scope = orgId ? " AND org_id = ?" : "";
  try {
    return db.query<{ id: string; company_name: string; legal_business_name?: string }>(
      `SELECT id, company_name, legal_business_name FROM clients WHERE COALESCE(service_area_json, '[]') NOT IN ('', '[]')${scope} ORDER BY company_name, id`,
      orgId ? [orgId] : [],
    ).map((r) => ({ id: str(r.id), name: str(r.company_name) || str(r.legal_business_name) || str(r.id) }));
  } catch { return []; }
}

/** The org's open jobs (not archived), newest last; `null` reads every org (superadmin), like every
 *  scoped list. Reads only. */
function openJobsForQueue(db: AppDb, orgId: string | null, limit = 500): Array<{ project: ProjectRecord; clientName: string }> {
  const scope = orgId ? " AND p.org_id = ?" : "";
  const rows = db.query<Record<string, unknown>>(
    `SELECT p.*, COALESCE(c.company_name, '') AS queue_client_name FROM projects p LEFT JOIN clients c ON c.id = p.client_id
      WHERE COALESCE(p.archived_at, '') = ''${scope} ORDER BY p.created_at ASC, p.id ASC LIMIT ?`,
    orgId ? [orgId, limit] : [limit],
  );
  return rows.map((r) => ({ project: mapProject(r as never), clientName: str(r.queue_client_name) }));
}

const jobLabel = (p: ProjectRecord): string =>
  [str(p.homeownerName), str(p.projectAddress) || str(p.city)].filter(Boolean).join(", ") || p.id;

/**
 * THE QUEUE, for one org. For each open job: its OUTSTANDING tracks (a track already submitted is not
 * waiting on a door), read through the job's own filingDestinationsFor. An authority a person already
 * verified (on any job's read) is left out and counted. Pure reads.
 */
export function filingDestinationQueue(
  db: AppDb,
  orgId: string | null,
  readTracks: (project: ProjectRecord) => Array<{ type: SubmittalTrackType; channel?: string; channelBasis?: string; outstanding?: boolean }>,
  pages: readonly HandCheckPage[] = handCheckPages(),
): DestinationQueue {
  const verifiedKeys = new Set<string>();
  const byClient = new Map<string, { clientId: string; clientName: string; authorities: Map<string, QueueAuthority> }>();
  let jobs = 0;
  for (const { project, clientName } of openJobsForQueue(db, orgId)) {
    let views;
    try { views = readTracks(project).filter((t) => t.outstanding !== false); } catch { continue; }
    if (!views.length) continue;
    let groups: AuthorityDestinations[];
    try { groups = filingDestinationsFor(db, project, views); } catch { continue; }
    if (!groups.length) continue;
    jobs++;
    const clientId = str(project.clientId);
    const c = byClient.get(clientId) ?? { clientId, clientName: clientName || (clientId ? clientId : "No client"), authorities: new Map<string, QueueAuthority>() };
    byClient.set(clientId, c);
    for (const g of groups) {
      const key = `${g.authority.kind}|${g.authority.profileKey}`;
      if (g.status === "verified") { verifiedKeys.add(key); continue; }
      const act: QueueAct = { projectId: project.id, track: g.tracks[0] };
      const a = c.authorities.get(key) ?? {
        authority: g.authority, tracks: [], status: "none" as const, proposals: [], rejected: [], skipped: [], jobs: [], open: act,
        handCheck: handCheckPagesFor(g.authority.kind, g.authority.state, g.authority.name, pages),
      };
      for (const t of g.tracks) if (!a.tracks.includes(t)) a.tracks.push(t);
      a.jobs.push({ projectId: project.id, label: jobLabel(project), tracks: [...g.tracks] });
      for (const p of g.proposals) if (!a.proposals.some((x) => x.id === p.id)) a.proposals.push({ ...p, act });
      for (const r of g.rejected) if (!a.rejected.some((x) => x.id === r.id)) a.rejected.push({ ...r, act });
      for (const s of g.skipped) if (!a.skipped.includes(s)) a.skipped.push(s);
      a.status = a.proposals.length ? "proposed" : "none";
      c.authorities.set(key, a);
    }
  }
  // THE SERVICE AREA: every authority a client's area names that none of ITS open jobs names yet,
  // marked "service area". Read through the same filingDestinationsFor, on an in-memory job.
  for (const client of clientsWithServiceArea(db, orgId)) {
    let area: ServiceAreaAuthority[];
    try { area = serviceAreaAuthorities(db, client.id); } catch { continue; }
    for (const sa of area) {
      const job = serviceAreaJob(client, sa);
      let views;
      try { views = readTracks(job).filter((t) => t.outstanding !== false); } catch { continue; }
      let groups: AuthorityDestinations[];
      try { groups = filingDestinationsFor(db, job, views); } catch { continue; }
      const c = byClient.get(client.id) ?? { clientId: client.id, clientName: client.name, authorities: new Map<string, QueueAuthority>() };
      byClient.set(client.id, c);
      for (const g of groups) {
        // Only the authority the entry names (its per-track issuer included, as on a real job).
        if (g.authority.kind !== sa.kind) continue;
        const key = `${g.authority.kind}|${g.authority.profileKey}`;
        if (g.status === "verified") { verifiedKeys.add(key); continue; }
        const existing = c.authorities.get(key);
        if (existing) {
          // Already listed for this client: by one of its jobs (that listing wins), or by another entry.
          for (const t of g.tracks) if (!existing.tracks.includes(t)) existing.tracks.push(t);
          continue;
        }
        const areaAct: QueueAreaAct = { clientId: client.id, entryKey: sa.entryKey, authorityKey: key, track: g.tracks[0] };
        c.authorities.set(key, {
          authority: g.authority, tracks: [...g.tracks], status: g.proposals.length ? "proposed" : "none",
          proposals: g.proposals.map((p) => ({ ...p, areaAct })), rejected: g.rejected.map((r) => ({ ...r, areaAct })), skipped: [...g.skipped],
          jobs: [], open: null,
          handCheck: handCheckPagesFor(g.authority.kind, g.authority.state, g.authority.name, pages),
          serviceArea: { entry: sa.entry, entryKey: sa.entryKey, matchedFrom: sa.matchedFrom },
        });
      }
    }
  }
  const counts = { jobs, authorities: 0, oneClick: 0, editOnly: 0, noProposal: 0, handCheck: 0, alreadyVerified: 0, serviceArea: 0 };
  const clients: DestinationQueue["clients"] = [];
  const counted = new Set<string>();
  const jobKeys = new Set<string>();
  for (const c of [...byClient.values()].sort((x, y) => x.clientName.localeCompare(y.clientName))) {
    // A verified read on ANY job means a person's record names the door: not waiting.
    const authorities = [...c.authorities.entries()].filter(([k]) => !verifiedKeys.has(k)).map(([, a]) => a)
      .sort((x, y) => x.authority.kind.localeCompare(y.authority.kind) || x.authority.state.localeCompare(y.authority.state) || x.authority.name.localeCompare(y.authority.name));
    for (const a of authorities) {
      const k = `${a.authority.kind}|${a.authority.profileKey}`;
      if (!a.serviceArea) jobKeys.add(k);
      if (counted.has(k)) continue; // shared across clients: counted once
      counted.add(k);
      counts.authorities++;
      if (a.proposals.some((p) => !p.problems.length)) counts.oneClick++;
      else if (a.proposals.length) counts.editOnly++;
      else counts.noProposal++;
      if (a.handCheck.length) counts.handCheck++;
    }
    if (authorities.length) clients.push({ clientId: c.clientId, clientName: c.clientName, authorities });
  }
  counts.alreadyVerified = verifiedKeys.size;
  // Waiting ONLY because a service area names it: no open job of any client listed here names it.
  counts.serviceArea = [...counted].filter((k) => !jobKeys.has(k)).length;
  return { clients, counts };
}
