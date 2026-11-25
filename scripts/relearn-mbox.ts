// RE-READ AN ALREADY-IMPORTED MAILBOX WITH THE CURRENT READER (knowledgeBase.relearnMboxKnowledgeFromFile).
//
// The earlier importer read raw MIME, so its correction examples were mostly notices and email
// footers. A plain re-import skips every message as a duplicate; this finds each one's earlier record
// and replaces its reading in place, files a correction example only for a real deficiency request,
// and rebuilds the shared correction counts of every place it touched.
//
// Dry run by default: the database is opened read-only and only counts are printed (category names
// and numbers, never an email's text). --apply writes, through openDatabase() (it migrates first, so
// stop the server or run it on a copy you then swap in).
//
//   npx tsx scripts/relearn-mbox.ts <file.mbox> [--db <path>]            dry run: what would change
//   npx tsx scripts/relearn-mbox.ts <file.mbox> --apply [--org <id>]     replace (AUTOPILOT_DB_PATH)
import fs from "node:fs";
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const flag = (name: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? String(argv[at + 1] ?? "").trim() : "";
};
const file = argv.find((a, i) => !a.startsWith("--") && !["--db", "--org"].includes(argv[i - 1] ?? "")) ?? "";
if (!file || !fs.existsSync(file)) {
  console.error("usage: npx tsx scripts/relearn-mbox.ts <file.mbox> [--db <path>] [--apply] [--org <id>]");
  process.exit(2);
}
await import("dotenv/config");
// Deterministic only: no model call happens here; make sure none could.
delete process.env.ANTHROPIC_API_KEY;

const { AppDb, DEFAULT_ORG_ID, openDatabase } = await import("../backend/src/db");
const { relearnMboxKnowledgeFromFile } = await import("../backend/src/knowledgeBase");
const { dbPath } = await import("../backend/src/statePaths");

const dbFile = flag("db") || dbPath();
if (apply && flag("db")) process.env.AUTOPILOT_DB_PATH = dbFile;
const db = apply ? await openDatabase() : new AppDb(new Database(dbFile, { readonly: true, fileMustExist: true }));
const result = await relearnMboxKnowledgeFromFile(db, { orgId: flag("org") || DEFAULT_ORG_ID, filePath: file, dryRun: !apply });
console.log(`${apply ? "Replaced" : "Dry run (nothing written)"}: ${result.messagesScanned} message(s) read, ${result.matched} found among earlier imports, ${result.notImported} never imported (left alone).`);
console.log(`Bucket changed on ${result.bucketChanged}. Correction examples: ${result.failureExamplesBefore} before -> ${result.failureExamplesAfter} after.`);
for (const [category, n] of Object.entries(result.byCategory).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${category}`);
if (apply) console.log(`Shared correction counts rebuilt for ${result.profilesRebuilt} place(s).`);
else console.log("Run again with --apply to write this.");
db.close();
