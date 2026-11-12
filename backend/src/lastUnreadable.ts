// WHY THE LAST STATUS CHECK READ NOTHING, ON THE CARD (#173).
//
// Since #161 a check that reads nothing says why — in a log line and a `permit_status.unreadable`
// audit row ("the sign-in failed: …", "the portal page read was a sign-in wall", "the filing has no
// application or permit number to look up"). Nothing put it in front of a person: a track card kept
// its last outcome and "last checked <date>", so a filing whose every check came back empty looked
// exactly like one whose status had not changed. That is how #161 itself went unnoticed.
//
// So the project detail carries, per target, the NEWEST unreadable reason and its time — derived
// from the audit rows (no new table), and only while it is newer than the target's last recorded
// reading: the first check that reads a status (or a person's Record status) clears it.
//
// RULE 2. The reason is free text built partly from an adapter's error message, and a Playwright
// error carries its call log — which logs `fill("<the value typed>")`, a password included. So the
// reason is scrubbed where it is recorded (rescheduleUnreadTarget, the sweep's noteReason) AND again
// where it is read (an audit row written before this scrub existed), never in the UI.
// Tenancy (rule 6): read by the project's own id, served only inside getProjectDetail /
// getSubmittalTracks, which every route already reaches through the project scope guard.
import type { LastUnreadableCheck } from "../../shared/src/types";
import { redactSecretValues } from "../../shared/src/portalSafety";
import type { AppDb } from "./db";

export const UNREADABLE_AUDIT_ACTION = "permit_status.unreadable";

const MAX_REASON = 300;

/**
 * A check's "why it read nothing" made safe for staff to read (rule 2). First line only (a
 * Playwright call log starts on the next one); a value Playwright logs as typed (`fill("…")`,
 * `type("…")`) and the value after a password / secret / token / key word followed by `:`, `=` or
 * "is" dropped; email addresses (a portal username) masked; a URL's query string and fragment
 * (session tokens) dropped; the project's own account / meter numbers redacted (the planner's
 * predicate, separators ignored); capped.
 *
 * `secrets` null means the project's secrets could not be read: fail closed, no free text at all.
 * Idempotent, so the write-time and read-time scrubs can both run.
 */
export function scrubUnreadableReason(raw: string, secrets: Iterable<string> | null): string {
  const first = String(raw ?? "").split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  if (!first) return "";
  if (secrets == null) return "the reason was withheld (this project's secrets could not be read to scrub it)";
  let s = redactSecretValues(first, secrets);
  s = s.replace(/\b(fill|type|pressSequentially|insertText)\(\s*("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)\s*\)?/g, "$1([redacted])");
  s = s.replace(/\b(pass(?:word|wd|code)|pwd|secret|token|api[\s_-]?key)\s*(?:[:=]|\bis\b)\s*("[^"]*"|'[^']*'|\S+)/gi, "$1 [redacted]");
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  s = s.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1");
  return s.length > MAX_REASON ? `${s.slice(0, MAX_REASON - 1)}…` : s;
}

/**
 * Each of the project's targets whose NEWEST check read nothing, with the scrubbed reason and when —
 * only where that is newer than the target's newest recorded reading (permit_status_checks). One
 * pass over the project's own audit rows; a row naming a target of another project is never read
 * (the query is by this project's id, and the caller applies the map to this project's targets only).
 */
export function lastUnreadableByTarget(db: AppDb, projectId: string, secrets: Iterable<string> | null): Map<string, LastUnreadableCheck> {
  const out = new Map<string, LastUnreadableCheck>();
  const rows = db.query<{ details: string; created_at: string }>(
    "SELECT details, created_at FROM audit_logs WHERE project_id = ? AND action = ? ORDER BY created_at DESC, rowid DESC",
    [projectId, UNREADABLE_AUDIT_ACTION],
  );
  if (!rows.length) return out;
  const lastReading = new Map(
    db.query<{ target_id: string; at: string }>(
      "SELECT target_id, MAX(created_at) AS at FROM permit_status_checks WHERE project_id = ? AND target_id IS NOT NULL GROUP BY target_id",
      [projectId],
    ).map((r) => [String(r.target_id), String(r.at ?? "")] as const),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    let details: { targetId?: unknown; reason?: unknown };
    try { details = JSON.parse(String(row.details || "{}")); } catch { continue; }
    const targetId = String(details?.targetId ?? "");
    if (!targetId || seen.has(targetId)) continue;
    seen.add(targetId); // the newest row for this target decides; older ones never resurface
    const at = String(row.created_at ?? "");
    const read = lastReading.get(targetId);
    if (read && read >= at) continue; // a later (or same-instant) reading superseded it
    out.set(targetId, { reason: scrubUnreadableReason(String(details?.reason ?? ""), secrets) || "no reason was recorded", at });
  }
  return out;
}
