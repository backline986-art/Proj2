// WHICH PORTAL BOXES DOES OUR READ OF THE PLAN SET AND UPLOADS LEAVE BLANK, HOW OFTEN, AND WHERE (#647).
//
// Owner, 2026-11-09: "ensure we're able to get all the needed relevant and more if so data from the
// planset/uploads ... and for the data you need to put the relevant info into the portals." The
// read is broad (text extraction, the structural/packet/AC-disconnect supplements, vision for scanned
// sets, the bill read, reviewer vision, the stage-gap gate #445), but nobody could say WHICH boxes a
// person still types by hand, how often, or on which portals. This answers that from real counts, so
// the next extraction work is picked by what is actually blank, not by guesses.
//
// HOW: for every project in scope and every track it needs (requiredTracks), it resolves that
// track's own complete recipe exactly as the track card does (findCompleteRecipeForProject, the
// issuer view for a permit track) and asks the stage gate's own walk (stageKeysForTrack, the same
// assembly stageGapsForTrack reads) which keys the recipe binds for that job and which are blank.
// It tallies per field key: across every portal, per portal host, and per AHJ for the permit tracks.
// The denominator of every percentage is the number of tracks whose recipe binds that key, so "blank
// in 40%" means 40% of the jobs that portal asked it on.
//
// WHERE THE FILLED VALUES CAME FROM, as far as the database records it (per filled key):
//   extracted               the parse at project creation wrote this value, or a document read
//                           (the bill read) lists the field;
//   person_corrected        a person edited it in the review queue;
//   person_confirmed        a person approved the extracted value in the review queue;
//   client_record           the submitting company's record supplies it (the staging overlay);
//   per_job_answer          a per-job portal question, answered by a person or the intake link;
//   changed_after_extraction the creation parse wrote a different value; a later save that was not
//                           a named person's changed it (a re-parse, the client form, a reader);
//                           a named person's change (field history, v92) reads person_corrected;
//   not_recorded            no record either way (derived by the replay, or a key the parse
//                           history does not track).
// A person's review outranks a document read, which outranks the creation parse.
//
// IT NEVER PRINTS A VALUE. Output is field keys, the fixed field names (gapFieldName), portal hosts,
// jurisdiction names, counts and percentages. No homeowner name, address, account or meter number;
// a secret field (rule 2) appears only by its fixed key and label, as recipeStageGaps names it. The
// values are read into memory only to compare against the creation parse, and are dropped.
//
// IT WRITES NOTHING. The database is opened with better-sqlite3 { readonly: true, fileMustExist }
// directly, never through openDatabase() (which migrates and re-seeds the knowledge base on every
// open). A read path that tried to write would throw here; that project/track is counted as
// unreadable rather than read as "nothing blank". fieldCoverageReport.test pins the file
// byte-identical after a run. No model call: nothing here reaches an LLM.
//
// UNIVERSAL: no portal, utility, AHJ or state is special-cased. The report is the same shape for
// any portal; a portal shows up because a recipe for it is on file.
//
//   npx tsx scripts/field-coverage-report.ts                       the default org
//   npx tsx scripts/field-coverage-report.ts --org <id>            one org
//   npx tsx scripts/field-coverage-report.ts --all                 every org
//   npx tsx scripts/field-coverage-report.ts --since 2026-10-01    projects created on or after
//   npx tsx scripts/field-coverage-report.ts --json > coverage.json
//   npx tsx scripts/field-coverage-report.ts --db <path>           a copy instead of AUTOPILOT_DB_PATH
//
// Projects created with learning_excluded (fixtures, demos, benchmarks) and archived projects are
// skipped and counted. Run it on a database the current main has migrated (start the server once).
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { ProjectRecord, SubmittalTrackType } from "../shared/src/types";
import { AppDb, DEFAULT_ORG_ID } from "../backend/src/db";
import { getProjectDetail } from "../backend/src/repository";
import { requiredTracks } from "../backend/src/submittalTracks";
import { loadPermitProcessRegistry, projectForTrack } from "../backend/src/permitProcess";
import { findCompleteRecipeForProject } from "../backend/src/portalRecipes";
import { recipeDisciplineForTrack } from "../backend/src/portalChannel";
import { stageKeysForTrack } from "../backend/src/recipeStageGapsView";
import type { RecipeStageKey } from "../backend/src/recipeStageGaps";
import { fieldAliases } from "../backend/src/normalize";

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export const PROVENANCE = [
  "extracted", "person_corrected", "person_confirmed", "client_record", "per_job_answer", "changed_after_extraction", "not_recorded",
] as const;
export type Provenance = (typeof PROVENANCE)[number];

export interface FieldTally {
  kind: RecipeStageKey["kind"];
  key: string;
  /** The fixed plain-words name (gapFieldName / the doc type): never a portal's recorded text. */
  fieldName: string;
  where: RecipeStageKey["where"];
  secret: boolean;
  /** Tracks whose recipe binds this key. */
  bound: number;
  /** Of those, how many had no value (the replay would type it blank). */
  blank: number;
  pctBlank: number;
  /** Where the filled values came from (fields and questions; documents have none). */
  source: Record<Provenance, number>;
}

export interface GroupTally {
  track: "nem" | "permit";
  portalHost: string;
  /** Permit groups by AHJ only: "AHJ, ST". */
  ahj?: string;
  /** Tracks read in this group (each with a recipe). */
  tracks: number;
  fields: FieldTally[];
}

export interface FieldCoverageReport {
  scope: { org: string; since: string };
  projects: { scanned: number; skippedLearningExcluded: number; skippedArchived: number };
  tracks: { withRecipe: number; withoutRecipe: number; unreadable: number };
  /** Tracks with no complete recipe of their own, by track type and jurisdiction. */
  noRecipe: Array<{ track: string; jurisdiction: string; count: number }>;
  /** Why a track could not be read (scrubbed messages: no quoted text, no long digit runs). */
  unreadable: Array<{ reason: string; count: number }>;
  overall: FieldTally[];
  byPortal: GroupTally[];
  byAhj: GroupTally[];
}

export interface FieldCoverageOptions {
  /** An org id, or null for every org. */
  orgId: string | null;
  /** YYYY-MM-DD: projects created on or after. "" = all. */
  since?: string;
}

// Recipe keys that name a field the parse history records under another key.
const RECORDED_AS: Record<string, string> = {
  inverterManufacturer: "inverterMake", moduleManufacturer: "moduleMake", moduleQuantity: "moduleQty",
  totalModuleQuantity: "moduleQty", inverterQuantity: "inverterQty", street: "projectAddress",
};
/** Every name the parse history and the review queue may record this key under. */
function recordedNames(key: string): string[] {
  const k = RECORDED_AS[key] ?? key;
  for (const [canon, aliases] of Object.entries(fieldAliases)) {
    if (canon === k || aliases.includes(k)) return [...new Set([key, canon, ...aliases])];
  }
  return [...new Set([key, k])];
}

const numeric = (v: string): number => {
  const t = v.replace(/,/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : NaN;
};
const alnum = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
function sameValue(a: string, b: string): boolean {
  const na = numeric(a);
  const nb = numeric(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  const x = alnum(a);
  return Boolean(x) && x === alnum(b);
}

/** What the database records about who wrote each field of ONE project. Values stay in memory. */
interface ProjectEvidence {
  review: Map<string, string>;
  documentRead: Set<string>;
  birth: Map<string, string[]>;
  /** Fields a NAMED person changed after intake (field history, migration v92: changed_by set). */
  personChanged: Set<string>;
}
function projectEvidence(db: AppDb, projectId: string): ProjectEvidence {
  const review = new Map<string, string>();
  for (const r of db.query<{ field_name: string; status: string }>(
    `SELECT field_name, status FROM human_review_items
      WHERE project_id = ? AND status IN ('approved', 'edited') ORDER BY updated_at DESC, rowid DESC`, [projectId],
  )) if (!review.has(r.field_name)) review.set(r.field_name, r.status);
  const documentRead = new Set<string>();
  for (const r of db.query<{ details: string }>(
    "SELECT details FROM audit_logs WHERE project_id = ? AND action = 'project.fields_read_from_document'", [projectId],
  )) {
    try {
      const d = JSON.parse(r.details || "{}") as { fields?: unknown };
      if (Array.isArray(d.fields)) for (const f of d.fields) documentRead.add(String(f));
    } catch { /* an unreadable audit row is no evidence */ }
  }
  // The creation parse (source_method "intake"; "regex" before v92). Before v92 every later save wrote
  // rows marked human_verified 1, the parser's included, so those prove nothing about a person; since
  // v92 a later save writes only the fields it changed, naming the person in changed_by when one did.
  const birth = new Map<string, string[]>();
  const personChanged = new Set<string>();
  for (const r of db.query<{ field_name: string; field_value: string; source_method: string; changed_by: string | null }>(
    "SELECT field_name, field_value, source_method, changed_by FROM extracted_fields WHERE project_id = ?", [projectId],
  )) {
    if (r.source_method === "intake" || r.source_method === "regex") birth.set(r.field_name, [...(birth.get(r.field_name) ?? []), s(r.field_value)]);
    else if (s(r.changed_by).trim()) personChanged.add(r.field_name);
  }
  return { review, documentRead, birth, personChanged };
}

export function provenanceOf(entry: RecipeStageKey, value: string, ev: ProjectEvidence): Provenance | null {
  if (entry.kind === "document") return null;
  if (entry.kind === "question") return "per_job_answer";
  if (entry.where === "client") return "client_record";
  const names = recordedNames(entry.key);
  const reviewed = names.map((n) => ev.review.get(n)).find(Boolean);
  if (reviewed === "edited") return "person_corrected";
  if (reviewed === "approved") return "person_confirmed";
  if (names.some((n) => ev.documentRead.has(n))) return "extracted";
  const born = names.flatMap((n) => ev.birth.get(n) ?? []);
  if (born.length) {
    if (born.some((b) => sameValue(b, value))) return "extracted";
    return names.some((n) => ev.personChanged.has(n)) ? "person_corrected" : "changed_after_extraction";
  }
  return "not_recorded";
}

/** An error message with no quoted text and no long digit runs, so a reason never carries a value. */
function scrubReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/"[^"]*"|'[^']*'|“[^”]*”|`[^`]*`/g, "…").replace(/\d{3,}/g, "#").replace(/\s+/g, " ").trim().slice(0, 120) || "unknown error";
}

const emptySource = (): Record<Provenance, number> =>
  Object.fromEntries(PROVENANCE.map((p) => [p, 0])) as Record<Provenance, number>;

class Tally {
  tracks = 0;
  private fields = new Map<string, FieldTally>();
  add(entry: RecipeStageKey, source: Provenance | null): void {
    const id = `${entry.kind}:${entry.key}`;
    let t = this.fields.get(id);
    if (!t) {
      t = { kind: entry.kind, key: entry.key, fieldName: entry.fieldName, where: entry.where, secret: entry.secret, bound: 0, blank: 0, pctBlank: 0, source: emptySource() };
      this.fields.set(id, t);
    }
    t.secret = t.secret || entry.secret;
    t.bound += 1;
    if (!entry.filled) t.blank += 1;
    else if (source) t.source[source] += 1;
  }
  rows(): FieldTally[] {
    return [...this.fields.values()]
      .map((t) => ({ ...t, pctBlank: t.bound ? Math.round((t.blank / t.bound) * 1000) / 10 : 0 }))
      .sort((a, b) => b.blank - a.blank || b.pctBlank - a.pctBlank || a.key.localeCompare(b.key));
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase() || "(no portal url)";
  } catch {
    return "(no portal url)";
  }
}

/** The report. Reads only; `db` should be opened read-only (openReadOnly). */
export function buildFieldCoverageReport(db: AppDb, opts: FieldCoverageOptions): FieldCoverageReport {
  const since = s(opts.since).trim();
  const where: string[] = [];
  const params: string[] = [];
  if (opts.orgId !== null) { where.push("org_id = ?"); params.push(opts.orgId); }
  if (since) { where.push("created_at >= ?"); params.push(since); }
  const rows = db.query<{ id: string; learning_excluded: number; archived_at: string }>(
    `SELECT id, learning_excluded, archived_at FROM projects ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`,
    params,
  );

  const report: FieldCoverageReport = {
    scope: { org: opts.orgId ?? "(all orgs)", since },
    projects: { scanned: 0, skippedLearningExcluded: 0, skippedArchived: 0 },
    tracks: { withRecipe: 0, withoutRecipe: 0, unreadable: 0 },
    noRecipe: [], unreadable: [], overall: [], byPortal: [], byAhj: [],
  };
  const overall = new Tally();
  const byPortal = new Map<string, { track: "nem" | "permit"; host: string; tally: Tally }>();
  const byAhj = new Map<string, { host: string; ahj: string; tally: Tally }>();
  const noRecipe = new Map<string, number>();
  const unreadable = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const row of rows) {
    if (Number(row.learning_excluded)) { report.projects.skippedLearningExcluded += 1; continue; }
    if (s(row.archived_at)) { report.projects.skippedArchived += 1; continue; }
    report.projects.scanned += 1;
    let project: ProjectRecord;
    let tracks: SubmittalTrackType[];
    try {
      project = getProjectDetail(db, row.id).project;
      tracks = requiredTracks(project);
    } catch (err) {
      report.tracks.unreadable += 1;
      bump(unreadable, `project: ${scrubReason(err)}`);
      continue;
    }
    let evidence: ProjectEvidence | null = null;
    for (const track of tracks) {
      try {
        // The recipe the track card resolves (submittalTracks.getSubmittalTracks): the issuer view
        // for a permit track, the project for NEM; scope and discipline from the track (rule 5).
        const category: "nem" | "permit" = track === "nem" ? "nem" : "permit";
        const issuerProject = category === "permit" ? projectForTrack(project, track) : project;
        const scopeType = category === "nem" ? "utility" : "ahj";
        const recipe = findCompleteRecipeForProject(db, {
          scopeType, state: project.state, ahj: issuerProject.ahj, utility: project.utility,
          ...(scopeType === "ahj" ? { discipline: recipeDisciplineForTrack(track) } : {}),
        });
        const jurisdiction = [category === "nem" ? s(project.utility) : s(issuerProject.ahj), s(project.state)].filter((x) => x.trim()).join(", ") || "(none on file)";
        if (!recipe || !Array.isArray(recipe.steps) || !recipe.steps.length) {
          report.tracks.withoutRecipe += 1;
          bump(noRecipe, `${track}\u0000${jurisdiction}`);
          continue;
        }
        const { keys, values } = stageKeysForTrack(db, project, track, recipe);
        evidence ??= projectEvidence(db, row.id);
        report.tracks.withRecipe += 1;
        const host = hostOf(s(recipe.portalUrl));
        const portalId = `${category}\u0000${host}`;
        const portal = byPortal.get(portalId) ?? { track: category, host, tally: new Tally() };
        byPortal.set(portalId, portal);
        const ahjGroup = category === "permit"
          ? (() => {
              const id = `${jurisdiction}\u0000${host}`;
              const g = byAhj.get(id) ?? { host, ahj: jurisdiction, tally: new Tally() };
              byAhj.set(id, g);
              return g;
            })()
          : null;
        overall.tracks += 1;
        portal.tally.tracks += 1;
        if (ahjGroup) ahjGroup.tally.tracks += 1;
        for (const k of keys) {
          const source = k.filled ? provenanceOf(k, s(values[k.key]), evidence) : null;
          overall.add(k, source);
          portal.tally.add(k, source);
          ahjGroup?.tally.add(k, source);
        }
      } catch (err) {
        report.tracks.unreadable += 1;
        bump(unreadable, `${track}: ${scrubReason(err)}`);
      }
    }
  }

  report.overall = overall.rows();
  report.byPortal = [...byPortal.values()]
    .map((g) => ({ track: g.track, portalHost: g.host, tracks: g.tally.tracks, fields: g.tally.rows() }))
    .sort((a, b) => b.tracks - a.tracks || a.track.localeCompare(b.track) || a.portalHost.localeCompare(b.portalHost));
  report.byAhj = [...byAhj.values()]
    .map((g) => ({ track: "permit" as const, portalHost: g.host, ahj: g.ahj, tracks: g.tally.tracks, fields: g.tally.rows() }))
    .sort((a, b) => b.tracks - a.tracks || s(a.ahj).localeCompare(s(b.ahj)) || a.portalHost.localeCompare(b.portalHost));
  report.noRecipe = [...noRecipe.entries()]
    .map(([k, count]) => { const [track, jurisdiction] = k.split("\u0000"); return { track, jurisdiction, count }; })
    .sort((a, b) => b.count - a.count || a.track.localeCompare(b.track) || a.jurisdiction.localeCompare(b.jurisdiction));
  report.unreadable = [...unreadable.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return report;
}

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────
const SOURCE_SHORT: Record<Provenance, string> = {
  extracted: "extracted", person_corrected: "person fixed", person_confirmed: "person ok'd", client_record: "client rec",
  per_job_answer: "per-job ans", changed_after_extraction: "changed later", not_recorded: "not recorded",
};
const pad = (v: unknown, n: number): string => s(v).length >= n ? `${s(v).slice(0, n - 1)}… ` : s(v).padEnd(n);
const lpad = (v: unknown, n: number): string => s(v).padStart(n);

function fieldTable(fields: FieldTally[]): string[] {
  const shown = fields.filter((f) => f.bound > 0);
  if (!shown.length) return ["    (no bound fields)"];
  const lines = [`    ${pad("field key", 30)}${pad("what", 34)}${pad("fill on", 10)}${lpad("blank", 6)}${lpad("of", 6)}${lpad("%", 7)}`];
  for (const f of shown) {
    const tag = f.kind === "document" ? " [doc]" : f.kind === "question" ? " [q]" : f.secret ? " [secret]" : "";
    lines.push(`    ${pad(f.key, 30)}${pad(f.fieldName + tag, 34)}${pad(f.where, 10)}${lpad(f.blank, 6)}${lpad(f.bound, 6)}${lpad(f.pctBlank.toFixed(1), 7)}`);
  }
  return lines;
}

export function renderFieldCoverageReport(r: FieldCoverageReport): string {
  const out: string[] = [];
  out.push("FIELD COVERAGE: which portal boxes the plan-set / upload read leaves blank (#647)");
  out.push(`Scope: org ${r.scope.org}${r.scope.since ? `, projects created on or after ${r.scope.since}` : ""}`);
  out.push(`Projects: ${r.projects.scanned} read, ${r.projects.skippedLearningExcluded} skipped (learning-excluded), ${r.projects.skippedArchived} skipped (archived)`);
  out.push(`Tracks: ${r.tracks.withRecipe} with a complete recipe, ${r.tracks.withoutRecipe} without one, ${r.tracks.unreadable} unreadable`);
  out.push("Counts only: no values, names or addresses. \"blank\" = the replay would type it empty; \"of\" = tracks whose recipe binds it.");
  out.push("");
  out.push("ALL PORTALS");
  out.push(...fieldTable(r.overall));
  for (const g of r.byPortal) {
    out.push("", `${g.track.toUpperCase()} portal ${g.portalHost} (${g.tracks} track${g.tracks === 1 ? "" : "s"})`);
    out.push(...fieldTable(g.fields));
  }
  for (const g of r.byAhj) {
    out.push("", `PERMIT, AHJ ${g.ahj} on ${g.portalHost} (${g.tracks} track${g.tracks === 1 ? "" : "s"})`);
    out.push(...fieldTable(g.fields));
  }
  const filled = r.overall.filter((f) => f.kind !== "document" && f.bound > f.blank);
  out.push("", "WHERE THE FILLED VALUES CAME FROM (all portals, filled tracks only)");
  if (!filled.length) out.push("    (nothing filled)");
  else {
    out.push(`    ${pad("field key", 30)}${PROVENANCE.map((p) => lpad(SOURCE_SHORT[p], 14)).join("")}`);
    for (const f of filled) out.push(`    ${pad(f.key, 30)}${PROVENANCE.map((p) => lpad(f.source[p], 14)).join("")}`);
  }
  if (r.noRecipe.length) {
    out.push("", "TRACKS WITH NO COMPLETE RECIPE OF THEIR OWN (not counted above)");
    for (const n of r.noRecipe) out.push(`    ${pad(n.track, 12)}${pad(n.jurisdiction, 50)}${lpad(n.count, 6)}`);
  }
  if (r.unreadable.length) {
    out.push("", "UNREADABLE (not counted above)");
    for (const u of r.unreadable) out.push(`    ${lpad(u.count, 5)}  ${u.reason}`);
  }
  return out.join("\n");
}

/** Open a database file read-only, without migrating or seeding (openDatabase does both). */
export function openReadOnly(file: string): AppDb {
  const raw = new Database(file, { readonly: true, fileMustExist: true });
  raw.pragma("busy_timeout = 5000");
  const db = new AppDb(raw);
  // The pure permit resolvers read this in-process registry (openDatabase loads it on boot).
  loadPermitProcessRegistry(db);
  return db;
}

/**
 * A READ PATH MAY START A BACKGROUND BACKFILL: getProjectDetail's plan-set text overlay
 * (planSetTextForProject) starts a text extraction for a stored PDF with no text on file, and that
 * extraction writes its result. On the read-only handle the write is refused (or, once the handle is
 * closed, finds it closed); count the refusal instead of letting it crash the run. Nothing is
 * written either way. Any other unhandled rejection still crashes, as it would without this.
 */
export function refuseBackgroundWrites(): () => number {
  let refused = 0;
  process.on("unhandledRejection", (err) => {
    if (/readonly|not open/i.test(err instanceof Error ? err.message : String(err))) { refused += 1; return; }
    throw err;
  });
  return () => refused;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await import("dotenv/config");
  // No model call happens here; make sure none could.
  delete process.env.ANTHROPIC_API_KEY;
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3).trim();
    const at = args.indexOf(`--${name}`);
    const next = at >= 0 ? args[at + 1] : undefined;
    return next && !next.startsWith("--") ? next.trim() : "";
  };
  const usage = (msg: string): never => {
    console.error(`${msg}\nUsage: npx tsx scripts/field-coverage-report.ts [--org <id>|--all] [--since YYYY-MM-DD] [--json] [--db <path>]`);
    process.exit(1);
  };
  const all = args.includes("--all");
  const org = flag("org");
  if (all && org) usage("Pass --org or --all, not both.");
  if (args.includes("--org") && !org) usage("--org needs an org id.");
  const since = flag("since");
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) usage("--since must be YYYY-MM-DD.");
  const { dbPath } = await import("../backend/src/statePaths");
  const file = flag("db") || dbPath();
  let db: AppDb;
  try {
    db = openReadOnly(file);
  } catch (err) {
    console.error(`Could not open ${file} read-only: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const refused = refuseBackgroundWrites();
  process.on("exit", () => {
    if (refused()) console.error(`(${refused()} background text backfill(s) tried to write and were refused: the database is open read-only.)`);
  });
  const report = buildFieldCoverageReport(db, { orgId: all ? null : org || DEFAULT_ORG_ID, since });
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : renderFieldCoverageReport(report));
  db.close();
}
