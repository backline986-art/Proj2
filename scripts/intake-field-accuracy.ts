// HOW OFTEN WAS INTAKE'S READ OF EACH FIELD RIGHT? (field history, migration v92; fieldHistory.ts)
//
// Per field, across projects: how many times intake read a value, how many of those a NAMED person
// later changed, how many something else changed (the client form, a reader, a re-parse), and how
// many intake left blank and were filled later. The fields at the top are where the reading needs work.
//
// IT NEVER PRINTS A VALUE: field names and counts only, so the output can be shared without customer
// data. IT WRITES NOTHING: the database is opened read-only (never through openDatabase(), which
// migrates). Run it on a database the current main has migrated (start the server once).
// Projects created before v92 recorded every save as a person's, so they over-count "changed by a
// person"; use --since with the date the server moved to v92 for exact counts.
//
//   npx tsx scripts/intake-field-accuracy.ts                    the default org
//   npx tsx scripts/intake-field-accuracy.ts --all              every org
//   npx tsx scripts/intake-field-accuracy.ts --since 2026-12-01 projects created on or after
//   npx tsx scripts/intake-field-accuracy.ts --json
//   npx tsx scripts/intake-field-accuracy.ts --db <path>        a copy instead of AUTOPILOT_DB_PATH
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AppDb, DEFAULT_ORG_ID } from "../backend/src/db";
import { intakeFieldAccuracy, type IntakeFieldAccuracy } from "../backend/src/fieldHistory";

export function renderIntakeFieldAccuracy(rows: IntakeFieldAccuracy[], projects: number): string {
  const lines = [
    `Intake field accuracy — ${projects} project(s)`,
    "field".padEnd(32) + "read".padStart(6) + "  person changed".padStart(17) + "  other changed".padStart(16) + "  filled later".padStart(15),
  ];
  for (const r of rows) {
    lines.push(r.field.slice(0, 31).padEnd(32) + String(r.read).padStart(6) + String(r.changedByPerson).padStart(17)
      + String(r.changedOtherwise).padStart(16) + String(r.filledLater).padStart(15));
  }
  return lines.join("\n");
}

const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await import("dotenv/config");
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const at = args.indexOf(`--${name}`);
    const next = at >= 0 ? args[at + 1] : undefined;
    return next && !next.startsWith("--") ? next.trim() : "";
  };
  const since = flag("since");
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error("--since must be YYYY-MM-DD.");
    process.exit(1);
  }
  const { dbPath } = await import("../backend/src/statePaths");
  const file = flag("db") || dbPath();
  const db = new AppDb(new Database(file, { readonly: true, fileMustExist: true }));
  const orgId = args.includes("--all") ? null : flag("org") || DEFAULT_ORG_ID;
  const { projects, fields } = intakeFieldAccuracy(db, orgId, since);
  console.log(args.includes("--json") ? JSON.stringify({ since, projects, fields }, null, 2) : renderIntakeFieldAccuracy(fields, projects));
  db.close();
}
