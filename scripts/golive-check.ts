// GO-LIVE CHECK, the command-line twin of the dashboard's Go-live check (backend/src/goLiveCheck.ts):
// every switch and setting this server reads, set / not set, what each one means, the database
// version, the destinations waiting on a person and the job queue.
//
//   npm run golive:check                 # in the install folder (reads the live .env)
//   npm run golive:check -- --json
//   npm run golive:check -- --org <id>   # the database counts for one org (default: every org)
//
// READ-ONLY. The database is opened with a READ-ONLY connection (a write would throw), so this never
// migrates or touches it, even when it is behind this build. It never prints a setting's value.
// Exit 0 with no red line, 1 with at least one (a blocker for going live).
import "dotenv/config";
import fs from "node:fs";
import { dbPath } from "../backend/src/statePaths";
import { AppDb } from "../backend/src/db";
import { goLiveReport, renderGoLiveText } from "../backend/src/goLiveCheck";
import { filingDestinationQueue } from "../backend/src/filingDestinationProposals";
import { getSubmittalTracks } from "../backend/src/submittalTracks";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const orgAt = argv.indexOf("--org");
const orgId = orgAt >= 0 && argv[orgAt + 1] ? String(argv[orgAt + 1]) : null;

let db: AppDb | null = null;
const file = dbPath();
if (fs.existsSync(file)) {
  try {
    const { default: Database } = await import("better-sqlite3");
    db = new AppDb(new Database(file, { readonly: true, fileMustExist: true }));
  } catch { db = null; }
}
try {
  const ro = db;
  const report = await goLiveReport(process.env, ro, orgId, {
    source: "cli",
    // The same queue the dashboard's Destinations to confirm view reads (a read: on this read-only
    // connection a write would throw and the line would say it could not be read).
    ...(ro ? { destinationCounts: (org: string | null) => filingDestinationQueue(ro, org, (p) => getSubmittalTracks(ro, p)).counts } : {}),
  });
  console.log(asJson ? JSON.stringify(report, null, 2) : renderGoLiveText(report));
  process.exitCode = report.ready ? 0 : 1;
} finally {
  db?.close();
}
