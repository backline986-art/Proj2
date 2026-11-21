// WHY DID THAT REPLAY STOP? One read-only report an operator can run on the server and paste back.
//
// "The run got stuck again", "it said cancelled but it reached review", "my hand-recorded recipe
// didn't replay" — each of those is answered by rows already in the database (portal_runs,
// portal_recipes, audit_logs, job_queue), but nobody can read them without a SQL shell. This prints,
// for the newest stage runs (or one project's):
//   - each run: track, status, how long, which recipe and version drove it, the failing step and its
//     own message, the last steps of its trace (where it was), stall/cancel markers, drift notes;
//   - each recipe those runs used, and every hand-recorded recipe: status, steps (action, field,
//     note — never a value), flag, the tail of its notes, its recent audit trail, and whether
//     staging would even pick it for the profile it is filed under;
//   - failed background jobs, grouped by type, with their newest distinct errors.
//
//   npx tsx scripts/replay-doctor.ts                      # newest 12 stage runs
//   npx tsx scripts/replay-doctor.ts --project <id>       # one project's runs
//   npx tsx scripts/replay-doctor.ts --runs 30            # more runs
//   npx tsx scripts/replay-doctor.ts > replay-doctor.txt  # to attach
//
// READ-ONLY: the database is opened readonly (no migration, no write). PRINTS NO SECRETS: no step or
// field value is printed, every run of 6+ digits is masked (account/meter numbers), and so is every
// e-mail address. Rule 2 holds for whatever is pasted from it.
import "dotenv/config";
import fs from "node:fs";
import Database from "better-sqlite3";
import { dbPath } from "../backend/src/statePaths";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? "") : "";
};

type Row = Record<string, unknown>;

/** Mask what must never be pasted: digit runs of 6+ (separators ignored) and e-mail addresses. */
export function mask(text: unknown): string {
  return String(text ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\d(?:[\s-]?\d){5,}/g, "<digits>");
}
const clip = (t: unknown, n: number): string => {
  const s = mask(t).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const parse = (t: unknown): Row => {
  try { const v = JSON.parse(String(t ?? "{}")); return v && typeof v === "object" ? v as Row : {}; } catch { return {}; }
};
const mins = (a: unknown, b: unknown): string => {
  const s = Date.parse(String(a ?? "")), e = Date.parse(String(b ?? ""));
  return Number.isFinite(s) && Number.isFinite(e) ? `${((e - s) / 60_000).toFixed(1)} min` : "?";
};

function main(): void {
  const file = dbPath();
  if (!fs.existsSync(file)) {
    console.error(`No database at ${file} (set AUTOPILOT_DB_PATH or run from the repository root).`);
    process.exit(2);
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const has = (table: string, col: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === col);
  const projectId = arg("project");
  const limit = Math.max(1, Math.min(200, Number(arg("runs")) || 12));
  const runCols = ["id", "project_id", "run_type", "status", "started_at", "finished_at", "error_message", "result_json"]
    .concat(["permit_type", "pause_reason", "recipe_id", "recipe_version", "runner"].filter((c) => has("portal_runs", c)));

  console.log(`Replay doctor — ${new Date().toISOString()} — database ${file}`);
  console.log("Read-only. Values are never printed; 6+ digit runs and e-mail addresses are masked.\n");

  const runs = db.prepare(
    `SELECT ${runCols.join(", ")} FROM portal_runs ${projectId ? "WHERE project_id = ?" : ""} ORDER BY started_at DESC LIMIT ${limit}`,
  ).all(...(projectId ? [projectId] : [])) as Row[];
  const recipeIds = new Set<string>();
  console.log(`== ${runs.length} newest portal run(s)${projectId ? ` for project ${projectId}` : ""} ==`);
  for (const r of runs) {
    const res = parse(r.result_json);
    const steps = Array.isArray(res.steps) ? res.steps as Row[] : [];
    const data: Row = Object.assign({}, ...steps.map((s) => (s && typeof s.data === "object" ? s.data as Row : {})));
    const project = db.prepare("SELECT ahj, utility, state FROM projects WHERE id = ?").get(String(r.project_id)) as Row | undefined;
    if (r.recipe_id) recipeIds.add(String(r.recipe_id));
    console.log(`\n-- run ${r.id}  ${r.started_at} (${mins(r.started_at, r.finished_at)})`);
    console.log(`   project ${r.project_id} (${clip(project?.ahj, 40)} / ${clip(project?.utility, 40)}, ${project?.state ?? ""}), track ${r.permit_type ?? "?"}, type ${r.run_type}`);
    console.log(`   status ${r.status}${r.pause_reason ? `, paused: ${r.pause_reason}` : ""}; runner ${r.runner || "?"}; recipe ${r.recipe_id ?? "-"} v${r.recipe_version ?? "?"}`);
    if (r.error_message) console.log(`   error: ${clip(r.error_message, 400)}`);
    const failing = steps.find((s) => s && s.ok === false);
    if (failing) console.log(`   failing step message: ${clip(failing.message, 400)}`);
    else if (res.message) console.log(`   message: ${clip(res.message, 300)}`);
    for (const k of ["replayStalled", "runCancelled", "failedStepIndex", "executed", "stoppedBeforeReview", "reviewFieldsSeen", "reviewFieldsConfirmed"]) {
      // Counts, indexes and durations only (a cancel's "by" is a person: its e-mail is masked).
      if (data[k] !== undefined) console.log(`   ${k}: ${JSON.stringify(data[k]).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>").slice(0, 200)}`);
    }
    for (const k of ["requiredStillEmpty", "driftWarnings", "agingNotes", "guardRefusals"]) {
      const list = Array.isArray(data[k]) ? data[k] as unknown[] : [];
      if (list.length) console.log(`   ${k} (${list.length}): ${list.slice(0, 6).map((x) => clip(typeof x === "string" ? x : JSON.stringify(x), 160)).join(" | ")}`);
    }
    const slow = Array.isArray(data.slowSteps) ? data.slowSteps as Row[] : [];
    if (slow.length) console.log(`   slowest: ${slow.slice(0, 4).map((s) => `${clip(JSON.stringify(s), 120)}`).join(" | ")}`);
    const trace = Array.isArray(data.trace) ? data.trace as Row[] : [];
    if (trace.length) {
      console.log(`   last ${Math.min(8, trace.length)} of ${trace.length} traced step(s):`);
      for (const t of trace.slice(-8)) console.log(`     #${Number(t.i) + 1} ${t.action} "${clip(t.note, 50)}" → ${clip(t.outcome, 90)}  [page: ${clip(t.page, 40)}]`);
    }
  }

  // Every recipe a person recorded by hand (the recorder CLI / a capture), plus the recipes those runs used.
  const handRows = db.prepare(
    `SELECT id FROM portal_recipes WHERE created_by NOT LIKE 'auto%' AND created_by NOT LIKE '%learn%' AND created_by <> '' ORDER BY updated_at DESC LIMIT 20`,
  ).all() as Row[];
  for (const h of handRows) recipeIds.add(String(h.id));
  const recipeCols = ["id", "scope_type", "profile_key", "state", "ahj", "utility", "discipline", "portal_platform", "portal_url", "status", "version", "steps_json", "created_by", "created_at", "updated_at", "notes"]
    .concat(["flag_reason", "flagged_at", "prev_steps_json"].filter((c) => has("portal_recipes", c)));
  console.log(`\n\n== ${recipeIds.size} recipe(s): the ones these runs used, and every hand-recorded one ==`);
  for (const id of recipeIds) {
    const rc = db.prepare(`SELECT ${recipeCols.join(", ")} FROM portal_recipes WHERE id = ?`).get(id) as Row | undefined;
    if (!rc) { console.log(`\n-- recipe ${id}: NOT FOUND (deleted or re-keyed since the run)`); continue; }
    const steps = (() => { try { const v = JSON.parse(String(rc.steps_json ?? "[]")); return Array.isArray(v) ? v as Row[] : []; } catch { return []; } })();
    const prev = (() => { try { const v = JSON.parse(String(rc.prev_steps_json ?? "[]")); return Array.isArray(v) ? v.length : 0; } catch { return 0; } })();
    // Would staging pick this recipe? It looks for status 'complete' under the same profile_key with
    // this discipline or '' — newest first. Another complete row under the key may win instead.
    const winner = db.prepare(
      `SELECT id, discipline, updated_at FROM portal_recipes WHERE profile_key = ? AND status = 'complete' AND (discipline = ? OR discipline = '')
        ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    ).get(rc.profile_key, rc.discipline ?? "", rc.discipline ?? "") as Row | undefined;
    const sameKey = db.prepare("SELECT id, status, discipline, created_by, updated_at FROM portal_recipes WHERE profile_key = ? AND id <> ?").all(rc.profile_key, id) as Row[];
    const lastRun = has("portal_runs", "recipe_id")
      ? db.prepare("SELECT id, status, started_at FROM portal_runs WHERE recipe_id = ? ORDER BY started_at DESC LIMIT 1").get(id) as Row | undefined
      : undefined;
    console.log(`\n-- recipe ${id}  [${rc.status}] v${rc.version}  ${rc.scope_type} "${rc.profile_key}" discipline "${rc.discipline ?? ""}"`);
    console.log(`   for ${clip(rc.ahj || rc.utility, 60)} (${rc.state}); platform ${rc.portal_platform || "?"}; url ${clip(rc.portal_url, 120)}`);
    console.log(`   created by ${clip(rc.created_by, 40)} ${rc.created_at}; updated ${rc.updated_at}; ${steps.length} step(s)${prev ? `; snapshot of ${prev} older step(s) kept` : ""}`);
    console.log(`   staging picks for this key+discipline: ${winner ? (winner.id === id ? "THIS recipe" : `ANOTHER recipe ${winner.id} (discipline "${winner.discipline}", updated ${winner.updated_at})`) : "NOTHING (no complete recipe under this key — a recording is never replayed)"}`);
    // A hand recording is saved with discipline "" (the record route takes none); an AHJ stage asks
    // for its own discipline first, so a complete structural/electrical row under the key wins over it.
    if (rc.scope_type === "ahj") {
      for (const d of ["structural", "electrical", "combo"]) {
        const w = db.prepare(
          `SELECT id FROM portal_recipes WHERE profile_key = ? AND status = 'complete' AND (discipline = ? OR discipline = '')
            ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
        ).get(rc.profile_key, d, d) as Row | undefined;
        console.log(`   a ${d} stage would replay: ${w ? (w.id === id ? "THIS recipe" : `recipe ${w.id}`) : "nothing"}`);
      }
    }
    if (sameKey.length) console.log(`   other rows under this key: ${sameKey.map((o) => `${o.id} [${o.status}] "${o.discipline}" by ${clip(o.created_by, 30)}`).join("; ")}`);
    if (lastRun) console.log(`   last run on it: ${lastRun.id} ${lastRun.status} ${lastRun.started_at}`);
    if (rc.flag_reason) console.log(`   FLAG (${rc.flagged_at}): ${clip(rc.flag_reason, 300)}`);
    if (rc.notes) console.log(`   notes (tail): ${clip(String(rc.notes).slice(-600), 600)}`);
    const counts: Record<string, number> = {};
    for (const s of steps) counts[String(s.action)] = (counts[String(s.action)] ?? 0) + 1;
    console.log(`   step kinds: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    const terminal = steps.filter((s) => s.action === "stopForReview" || s.isFinalSubmit === true).length;
    if (!terminal) console.log("   NOTE: no stopForReview and no final-submit step — a replay of it never reaches a review stop.");
    steps.forEach((s, i) => {
      const sel = (s.selector ?? {}) as Row;
      const how = sel.label ? `label "${clip(sel.label, 40)}"` : sel.role ? `role ${sel.role} "${clip(sel.name, 40)}"` : sel.css ? `css ${clip(sel.css, 50)}` : sel.text ? `text "${clip(sel.text, 40)}"` : "no selector";
      const bind = s.field ? ` ← ${s.field}` : (s.value !== undefined && s.value !== "" ? " ← (recorded literal)" : "");
      const doc = s.action === "upload" ? (s.docType ? ` [docType ${clip(s.docType, 30)}]` : " [NO docType — set it in the dashboard or the upload cannot replay]") : "";
      console.log(`     ${String(i + 1).padStart(3)} ${String(s.action).padEnd(13)} ${how}${bind}${doc}${s.optional ? " (optional)" : ""}${s.sensitive ? " (sensitive)" : ""}${s.isFinalSubmit ? " [FINAL SUBMIT]" : ""}  ${clip(s.note, 60)}`);
    });
    const audits = db.prepare(
      `SELECT created_at, actor_type, action, details FROM audit_logs WHERE action LIKE 'portal%' AND details LIKE ? ORDER BY created_at DESC LIMIT 12`,
    ).all(`%${id}%`) as Row[];
    if (audits.length) {
      console.log("   audit (newest first):");
      for (const a of audits) {
        const d = parse(a.details);
        const why = d.reason ?? d.attribution ?? d.failureText ?? d.via ?? "";
        console.log(`     ${a.created_at} ${a.actor_type} ${a.action}${why ? `: ${clip(typeof why === "string" ? why : JSON.stringify(why), 160)}` : ""}`);
      }
    }
  }

  const failed = db.prepare(
    "SELECT job_type, COUNT(*) AS n, MAX(finished_at) AS last FROM job_queue WHERE status = 'failed' GROUP BY job_type ORDER BY n DESC",
  ).all() as Row[];
  console.log(`\n\n== failed background jobs: ${failed.reduce((t, f) => t + Number(f.n), 0)} ==`);
  for (const f of failed) {
    console.log(`\n-- ${f.job_type}: ${f.n} (newest ${f.last ?? "?"})`);
    const errs = db.prepare(
      "SELECT error, finished_at, project_id FROM job_queue WHERE status = 'failed' AND job_type = ? ORDER BY finished_at DESC LIMIT 40",
    ).all(f.job_type) as Row[];
    const seen = new Set<string>();
    for (const e of errs) {
      const line = clip(String(e.error ?? "").split("\n")[0], 260);
      if (seen.has(line)) continue;
      seen.add(line);
      console.log(`   ${e.finished_at ?? "?"} ${e.project_id ?? ""}: ${line}`);
      if (seen.size >= 5) break;
    }
  }
  db.close();
}

main();
