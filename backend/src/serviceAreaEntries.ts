// The entries of a client's service area: their shape, the strict check a write runs and the lenient
// read of what is stored. PURE and dependency-light on purpose (clients.ts imports it): resolving an
// entry to an authority is clientServiceArea.ts's job. See that file's header for what the area is.
import type { ClientServiceAreaEntry } from "../../shared/src/types";
import { usStateCode } from "./usState";

export type { ClientServiceAreaEntry } from "../../shared/src/types";
export type ServiceAreaKind = ClientServiceAreaEntry["kind"];
export const SERVICE_AREA_KINDS: readonly ServiceAreaKind[] = ["state", "city", "county", "utility"];
/** A generous cap: a regional installer names a few dozen places; a list past this is a paste error. */
export const SERVICE_AREA_MAX_ENTRIES = 300;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const oneLine = (v: unknown): string => str(v).replace(/\s+/g, " ").slice(0, 120);

/** "WY", "Wyoming" → "WY"; any other two letters as typed (tests and unlisted territories use them,
 *  as project rows do). "" when it is not a state. */
function stateOf(v: unknown): string {
  const t = str(v);
  const code = usStateCode(t);
  if (code) return code;
  const up = t.toUpperCase();
  return /^[A-Z]{2}$/.test(up) ? up : "";
}

function kindOf(v: unknown): ServiceAreaKind | "" {
  const k = str(v).toLowerCase();
  return (SERVICE_AREA_KINDS as readonly string[]).includes(k) ? (k as ServiceAreaKind) : "";
}

/** One entry's identity: the same place typed twice is one entry. */
export function serviceAreaEntryKey(e: Pick<ClientServiceAreaEntry, "kind" | "state" | "name">): string {
  const name = str(e.name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${e.kind}|${str(e.state).toUpperCase()}|${e.kind === "state" ? "" : name}`;
}

/** What is wrong with each entry of a list as sent (empty = it can be stored). The strict reader for a
 *  write: an entry that cannot name anything is refused, never stored and silently ignored. */
export function serviceAreaProblems(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return ["serviceArea must be a list of { kind, state, name } entries."];
  const out: string[] = [];
  if (raw.length > SERVICE_AREA_MAX_ENTRIES) out.push(`serviceArea lists ${raw.length} entries; at most ${SERVICE_AREA_MAX_ENTRIES}.`);
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const where = `serviceArea[${i}]`;
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const kind = kindOf(o.kind);
    const state = stateOf(o.state);
    const name = oneLine(o.name);
    if (!kind) { out.push(`${where}.kind "${str(o.kind)}" is not one of ${SERVICE_AREA_KINDS.join(", ")}.`); return; }
    if (!state) { out.push(`${where}.state "${str(o.state)}" is not a state: use its two-letter code.`); return; }
    if (kind !== "state" && !name) { out.push(`${where}: a ${kind} entry names the ${kind}.`); return; }
    if (kind !== "state" && !/[a-z]/i.test(name)) { out.push(`${where}.name "${name}" is not a name.`); return; }
    const key = serviceAreaEntryKey({ kind, state, name });
    if (seen.has(key)) out.push(`${where} repeats ${kind === "state" ? state : `${name}, ${state}`}: list each place once.`);
    seen.add(key);
  });
  return out;
}

/** The stored list, read leniently: an unreadable entry is dropped, never guessed at. Pure. */
export function parseServiceArea(raw: unknown): ClientServiceAreaEntry[] {
  let list: unknown = raw;
  if (typeof raw === "string") { try { list = JSON.parse(raw || "[]"); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  const out: ClientServiceAreaEntry[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, SERVICE_AREA_MAX_ENTRIES)) {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const kind = kindOf(o.kind);
    const state = stateOf(o.state);
    const name = kind === "state" ? "" : oneLine(o.name);
    if (!kind || !state || (kind !== "state" && !/[a-z]/i.test(name))) continue;
    const key = serviceAreaEntryKey({ kind, state, name });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, state, name });
  }
  return out;
}

/** Add entries to a stored list (the onboarding script's merge: a re-run only adds). */
export function mergeServiceArea(stored: unknown, adds: unknown): ClientServiceAreaEntry[] {
  return parseServiceArea([...parseServiceArea(stored), ...parseServiceArea(adds)]);
}

