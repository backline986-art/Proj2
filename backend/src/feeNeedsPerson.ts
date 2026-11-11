// THE FEE PAGES A PERSON READS (fee round, 2026-11).
//
// When Keelix has no schedule behind a fee, the quote must say more than "unknown": it names the
// pages a person can open to settle it. Measured on saved pages: a city whose site refuses every
// automated read had the refusal on its lookup row and its permit card, while the fee quote beside
// them offered a rough estimate with no word that the fee page was blocked.
//
// One read-only answer, gathered from what Keelix already recorded and never from a new fetch:
//   - the lookup's refused reads (needsPersonRead: a challenge, 401 / 403 / 429, a host backed off);
//   - the fee schedules the lookup found and does not rely on (feeReadsForPerson: dated, archived,
//     gone, no readable text, or a formula on the job's cost);
//   - the utility's cited fees that did not land (feesHeld: two application fees, a fee by size or
//     level, a page Keelix could not re-read, a difference from the fee on file);
//   - the documents this project's last fee research asked for and did not get.
//
// Never a number, never a guess, and nothing here changes what is charged: the amount stays what
// the quote ladder says (an estimate, or unknown) until a person reads the page or a schedule lands.

import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { getPermitProcessLookup } from "./permitProcess";
import { getUtilityFilingLookup } from "./utilityFilingLookup";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const keyOf = (url: string): string => str(url).replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();

export interface FeeReadForPerson { url: string; reason: string }

/** The fee pages a person reads for this project's track, most specific first, at most six. Reads
 *  only; never throws (a broken row reads as nothing to report). */
export function feeReadsNeedingAPerson(
  db: AppDb,
  project: Pick<ProjectRecord, "id" | "state" | "ahj" | "utility">,
  track: "permit" | "nem",
): FeeReadForPerson[] {
  const out: FeeReadForPerson[] = [];
  const add = (url: unknown, reason: string) => {
    const u = str(url);
    if (!/^https?:\/\//i.test(u) || out.some((o) => keyOf(o.url) === keyOf(u))) return;
    out.push({ url: u.slice(0, 500), reason: str(reason).slice(0, 240) });
  };
  try {
    if (track === "permit" && str(project.ahj)) {
      const lookup = getPermitProcessLookup(db, str(project.state), str(project.ahj));
      for (const r of lookup?.feeReadsForPerson ?? []) add(r.url, r.reason);
      for (const r of lookup?.needsPersonRead ?? []) add(r.url, `the site refused Keelix's read (${str(r.reason)}): the fee may be on it`);
    }
    if (track === "nem" && str(project.utility)) {
      const lookup = getUtilityFilingLookup(db, str(project.state), str(project.utility));
      for (const h of lookup?.feesHeld ?? []) add(h.sourceUrl, `the utility's page prints "${str(h.label)}" ${money(Number(h.amountUsd))}, not charged by Keelix: ${str(h.reason)}`);
      for (const r of lookup?.needsPersonRead ?? []) add(r.url, `the site refused Keelix's read (${str(r.reason)}): the fee may be on it`);
    }
  } catch { /* a lookup row that cannot be read reports nothing */ }
  // THIS PROJECT'S OWN LAST FEE RESEARCH (its own job rows only: rule 6, nothing crosses projects).
  try {
    const rows = db.query<{ result: string | null }>(
      "SELECT result FROM job_queue WHERE project_id = ? AND job_type = 'fee_research' AND status = 'done' ORDER BY finished_at DESC LIMIT 8",
      [project.id],
    );
    for (const row of rows) {
      let result: { track?: unknown; saved?: unknown; unread?: unknown } | null = null;
      try { result = JSON.parse(str(row.result) || "null"); } catch { result = null; }
      if (!result || str(result.track) !== track) continue;
      // The latest pass for this track decides: one that saved a schedule leaves nothing to read.
      if (result.saved !== true && Array.isArray(result.unread)) {
        for (const u of result.unread as Array<{ url?: unknown; reason?: unknown }>) add(u?.url, `fee research could not get this document (${str(u?.reason) || "no response"})`);
      }
      break;
    }
  } catch { /* no job table in a bare test database: nothing to report */ }
  return out.slice(0, 6);
}

/** The sentence the fee quote carries, "" when there is nothing for a person to read. */
export function feeReadsSentence(reads: ReadonlyArray<FeeReadForPerson>): string {
  if (!reads.length) return "";
  return ` Needs a person to read before this fee is relied on: ${reads.map((r) => `${r.url} (${r.reason})`).join("; ")}.`;
}
