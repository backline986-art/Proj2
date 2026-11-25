// AN OLDER BUILD REFUSES A DATABASE A NEWER BUILD ALREADY MIGRATED (#203).
//
// Production once started a 6-day-old pinned build against a database the current build had migrated,
// with no warning: the old code's boot-time writes (CREATE TABLE IF NOT EXISTS, addColumnIfMissing)
// and its reads ran against tables and columns it did not know. openDatabase() now checks
// schema_meta BEFORE it writes anything.
//
// The "newer build" is simulated by stamping a schema_meta row above this build's newest migration:
// there is no newer build in a test, and that row is exactly what one would have written.
//   npx tsx backend/test/olderBuildBootGuard.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "older-build-guard-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "CODE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AUTOPILOT_ALLOW_OLDER_BUILD;

const { openDatabase, latestSchemaVersion, olderBuildProblem } = await import("../src/db");
const { removeTempDir } = await import("./_tmpdir").catch(() => ({ removeTempDir: (d: string) => fs.rmSync(d, { recursive: true, force: true }) }));

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const code = latestSchemaVersion();
const raw = () => new Database(process.env.AUTOPILOT_DB_PATH!);

await check("olderBuildProblem: same version, older database and a fresh database (v0) are fine", () => {
  assert.equal(olderBuildProblem(code, code), null);
  assert.equal(olderBuildProblem(code - 1, code), null);
  assert.equal(olderBuildProblem(0, code), null);
  assert.match(String(olderBuildProblem(code + 1, code)), new RegExp(`up to v${code}.*v${code + 1}`));
});

await check("a fresh database opens and is migrated to this build's version", async () => {
  const db = await openDatabase();
  db.close();
  const r = raw();
  assert.equal(Number(r.prepare("SELECT MAX(version) AS v FROM schema_meta").get()!.v), code);
  r.close();
});

// A newer build migrated it: one version past this build's newest, and a table the boot code would
// recreate dropped, so any write by this build would show.
{
  const r = raw();
  r.prepare("INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)").run(code + 5, "a_newer_build", new Date().toISOString());
  r.exec("DROP TABLE IF EXISTS portal_record_documents");
  r.close();
}

await check("MUST-EXCLUDE: this (older) build refuses the newer database, naming both versions and the way out", async () => {
  await assert.rejects(() => openDatabase(), (err: Error) => {
    assert.match(err.message, /REFUSED/);
    assert.match(err.message, new RegExp(`up to v${code}\\b`));
    assert.match(err.message, new RegExp(`v${code + 5}\\b`));
    assert.match(err.message, /AUTOPILOT_ALLOW_OLDER_BUILD=1/);
    return true;
  });
});

await check("MUST-EXCLUDE: the refusal wrote nothing (the dropped table is still missing, no schema row added)", () => {
  const r = raw();
  const table = r.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portal_record_documents'").get();
  const rows = Number(r.prepare("SELECT COUNT(*) AS n FROM schema_meta").get()!.n);
  const max = Number(r.prepare("SELECT MAX(version) AS v FROM schema_meta").get()!.v);
  r.close();
  assert.equal(table, undefined, "openDatabase migrated the newer database before refusing");
  assert.equal(max, code + 5);
  assert.ok(rows >= 1);
});

await check("the explicit override opens it anyway (a loud warning, not a refusal)", async () => {
  process.env.AUTOPILOT_ALLOW_OLDER_BUILD = "1";
  try {
    const db = await openDatabase();
    db.close();
  } finally {
    delete process.env.AUTOPILOT_ALLOW_OLDER_BUILD;
  }
});

removeTempDir(tmp);
if (failures) { console.error(`\n${failures} older-build guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll older-build guard checks passed.");
process.exit(0);
