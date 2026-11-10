// ---------------------------------------------------------------------------
// PAGES A PERSON CHECKS BY HAND (owner, 2026-11-10: "Destinations to confirm").
//
// When the reference rows were researched, some authorities' public pages refused an automated read
// (a connection reset, a bot wall, an HTTP error). Those authorities' rows may lack what the page says,
// so the "Destinations to confirm" view shows "check by hand" with the page link beside them.
//
// DATA, NOT CODE (owner, 2026-11-09: keep it universal): the pages are per-authority records in
// backend/data/reference-hand-check-pages.json (or HAND_CHECK_PAGES_PATH). A new market adds rows
// there; nothing here names a state, city, utility or portal.
//
// A record is a LINK, nothing more: it names no filing door, verifies nothing and decides no channel.
// A person opens it and records what they read through the dashboard's own Confirm / Edit / Verify
// (rule 3: a person's record, never an edit of the shipped file). Read-only: loading writes nothing.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ahjNameCore } from "./permitProcess";
import { utilityFilingKey } from "./utilityFilingLookup";

export interface HandCheckPage {
  authorityKind: "ahj" | "utility";
  state: string;
  authority: string;
  pageUrl: string;
  happened: string;
  check: string;
  recordedAt: string;
  source: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const HAND_CHECK_PAGES_ENV = "HAND_CHECK_PAGES_PATH";
function referencePath(): string {
  const explicit = str(process.env[HAND_CHECK_PAGES_ENV]);
  return explicit ? path.resolve(explicit) : path.resolve(moduleDir, "..", "data", "reference-hand-check-pages.json");
}

/** One record, or null when it is not usable (unknown kind, no state or name, a page that is not http(s)). */
export function parseHandCheckPage(raw: unknown): HandCheckPage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const authorityKind = str(r.authorityKind);
  if (authorityKind !== "ahj" && authorityKind !== "utility") return null;
  const state = str(r.state).toUpperCase();
  const authority = str(r.authority);
  const pageUrl = str(r.pageUrl);
  if (!/^[A-Z]{2}$/.test(state) || !authority) return null;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  } catch { return null; }
  return {
    authorityKind, state, authority, pageUrl,
    happened: str(r.happened).slice(0, 300), check: str(r.check).slice(0, 600),
    recordedAt: str(r.recordedAt).slice(0, 40), source: str(r.source).slice(0, 120),
  };
}

let cache: { file: string; mtimeMs: number; pages: HandCheckPage[] } | null = null;

/** Every usable record; [] when the file is missing or unreadable (the view then shows no hand checks). */
export function handCheckPages(): HandCheckPage[] {
  const file = referencePath();
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return []; }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.pages;
  let pages: HandCheckPage[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { pages?: unknown };
    pages = (Array.isArray(raw.pages) ? raw.pages : []).map(parseHandCheckPage).filter((p): p is HandCheckPage => !!p);
  } catch { pages = []; }
  cache = { file, mtimeMs, pages };
  return pages;
}

/** The authority's key for matching: an AHJ by state + its distinctive name core ("Example City" =
 *  "City of Example"), a utility by its filing-lookup key. */
export function handCheckKey(kind: "ahj" | "utility", state: string, name: string): string {
  if (kind === "utility") return `utility|${utilityFilingKey(state, name)}`;
  const core = ahjNameCore(name);
  return core ? `ahj|${str(state).toLowerCase()}|${core}` : "";
}

/** The hand-check pages for one authority (the same kind, state and name). */
export function handCheckPagesFor(kind: "ahj" | "utility", state: string, name: string, pages: readonly HandCheckPage[] = handCheckPages()): HandCheckPage[] {
  const key = handCheckKey(kind, state, name);
  if (!key) return [];
  return pages.filter((p) => p.authorityKind === kind && handCheckKey(p.authorityKind, p.state, p.authority) === key);
}
