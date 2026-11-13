// AN AHJ'S BLANK FORM AS AN OFFICIAL DOCUMENT (official-source auto-verify, slice 5; CLAUDE.md rule 3).
//
// A stored blank (ahj_form_templates) is graded at READ time — nothing is stamped on the row — as
// the authority's own document when all three hold:
//   1. its source_url host passes the ONE predicate, shared/src/officialSource.isOfficialSourceHost
//      (a government host, or a domain a person verified or a government page vouched for as the
//      authority's own: officialAuthorityHosts);
//   2. the bytes stored are the bytes Keelix retrieved: field_map.sourceHash, stamped by
//      storeAhjFormTemplate from the downloaded bytes, equals the sha256 of the stored blob now;
//   3. retrieved_at is set (an ISO date), so the label can say WHEN Keelix read it.
// A hand upload carries no source_url, so it is never official; a blob that no longer hashes to its
// stamp, a host that fails the predicate, or a row with no retrieval date stays exactly as it is today.
//
// WHAT THIS GRADE IS NOT. It says the BLANK came from the authority. It says nothing about the FIELD
// MAPPING, which stays a person's: field_map.verified (rule 3: map.verified on form templates) is
// never read, set, widened or implied here, and every gate that asks for a verified map (the fill
// gate, the submit gate, the approval review) still asks exactly as before. It is not a filing door
// and decides nothing about where a filing goes or whether one is sent. Reads only.
import crypto from "node:crypto";
import type { AppDb } from "./db";
import { isOfficialSourceHost, officialSourceWords, sourceHostOf } from "../../shared/src/officialSource";
import { officialAuthorityHosts } from "./officialAuthorityHosts";

export interface OfficialFormDocument {
  /** The host the blank was read from. */
  host: string;
  sourceUrl: string;
  /** When Keelix retrieved the bytes (the row's retrieved_at). */
  fetchedAt: string;
  /** "Verified from <host>, <date>" — the shared official-tier words, never "Verified by <person>". */
  words: string;
}

export interface FormDocumentEvidence {
  sourceUrl: string;
  retrievedAt: string;
  /** field_map.sourceHash: the sha256 stamped from the bytes at download. */
  sourceHash: string;
  bytes: Uint8Array | null | undefined;
}

/** The grade, from evidence alone: the caller supplies the authority's own hosts. Null unless all
 *  three conditions hold. */
export function officialFormDocumentFrom(input: FormDocumentEvidence, authorityHosts: readonly string[]): OfficialFormDocument | null {
  const sourceUrl = String(input.sourceUrl ?? "").trim();
  if (!sourceUrl || !isOfficialSourceHost(sourceUrl, authorityHosts)) return null;
  const fetchedAt = String(input.retrievedAt ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(fetchedAt)) return null;
  const stamped = String(input.sourceHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(stamped) || !input.bytes || !input.bytes.length) return null;
  if (crypto.createHash("sha256").update(input.bytes).digest("hex") !== stamped) return null;
  const host = sourceHostOf(sourceUrl);
  return { host, sourceUrl, fetchedAt, words: officialSourceWords(host, fetchedAt) };
}

/** The grade for a stored row of `authority` (the row's own ahj_name: a county's blank filled for a
 *  city job is graded against the county's hosts). Never throws: a failed host read is no grade. */
export function officialFormDocument(db: AppDb | null, authority: { state: string; ahj: string }, input: FormDocumentEvidence): OfficialFormDocument | null {
  let hosts: string[] = [];
  try { hosts = officialAuthorityHosts(db, authority.state, authority.ahj); } catch { hosts = []; }
  try { return officialFormDocumentFrom(input, hosts); } catch { return null; }
}

/** Who stands behind the MAPPING of a stored blank: a person (field_map.verified), the built-in map
 *  written in code for this exact blank (effectiveStoredFieldMap), or nobody yet. */
export type FormMappingStanding = "person" | "built_in" | "unchecked";

/** The words for a form card: the official grade, and — when the mapping is not a person's — whose
 *  it is, so the one is never read as the other. "" when the blank is not official. */
export function officialFormWords(doc: OfficialFormDocument | null, mapping: FormMappingStanding): string {
  if (!doc) return "";
  const tail = mapping === "person" ? "" : mapping === "built_in" ? "; mapping built in for this exact revision" : "; mapping not checked by a person";
  return `Blank form: ${doc.words}${tail}`;
}
