// A BULK DROP NEVER FAILS ON A FOLDER NAME THE FILE SYSTEM CANNOT STORE (#119).
//
// extractZipToWorkdir wrote every zip entry under its own name. Windows refuses < > : " | ? *,
// control characters, a trailing dot or space and the device names, so a Mac-made folder like
// "Smith: 123 Main St" threw and failed the WHOLE upload. Now such a segment lands under a safe
// name and the person still sees the name they gave it.
//
//   MUST-PASS    every entry is written; no on-disk name carries an unstorable character; the
//                job list shows the ORIGINAL folder names; two originals that clean to the same
//                name stay two folders; a loose file keeps its given name.
//   MUST-EXCLUDE a zip-slip entry is still skipped; a clean name is untouched (no manifest).
// Run: npx tsx backend/test/jobDropZipNames.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "job-drop-names-"));
process.env.BATCH_UPLOAD_DIR = path.join(tmp, "uploads");
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "unused.sqlite");
const { extractZipToWorkdir, safeZipSegment, ZIP_NAMES_MANIFEST } = await import("../src/batchZip");
const { jobFolders } = await import("../src/bulkJobDrop");
const { removeTempDir } = await import("./_tmpdir").catch(() => ({ removeTempDir: (d: string) => fs.rmSync(d, { recursive: true, force: true }) }));

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const UNSTORABLE = /[<>:"|?*\u0000-\u001f]|[. ]$/;
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...walk(path.join(d, e.name))] : [e.name]));

const MARKUP = "<img src=x onerror=window.__pwned=1>";
const PDF = Buffer.from("%PDF-1.4\n%synthetic\n");
const zip = new AdmZip();
zip.addFile("Job A/planset.pdf", PDF);
zip.addFile("Smith: 123 Main St/planset.pdf", PDF);
zip.addFile(`${MARKUP}/planset.pdf`, PDF);
zip.addFile("Trailing dot./planset.pdf", PDF);
zip.addFile("CON/planset.pdf", PDF);
zip.addFile("Twin?/planset.pdf", PDF);
zip.addFile("Twin*/planset.pdf", PDF);
zip.addFile("Job A/Nested: photos/roof.pdf", PDF);
zip.addFile("notes|loose.txt", Buffer.from("loose"));
// adm-zip's addFile cleans "../" off a name; a hostile zip carries it, so write the raw name.
zip.addFile("escape.pdf", PDF);
zip.getEntry("escape.pdf")!.entryName = "../escape.pdf";

console.log("job-drop zip names (#119)");
let out: { folderPath: string; pdfCount: number; totalEntries: number } | null = null;
check("MUST-PASS: a zip with unstorable folder names extracts without throwing", () => {
  out = extractZipToWorkdir(zip.toBuffer(), "jobs", "org-test");
  assert.equal(out.pdfCount, 8, "every PDF except the skipped escape entry");
});
check("MUST-PASS: no on-disk name carries an unstorable character or a trailing dot/space", () => {
  const names = walk(out!.folderPath).filter((n) => n !== ZIP_NAMES_MANIFEST);
  const bad = names.filter((n) => UNSTORABLE.test(n));
  assert.deepEqual(bad, [], `unstorable names on disk: ${bad.join(", ")}`);
  assert.ok(names.length >= 8, names.join(", "));
});
check("MUST-PASS: the job list shows the ORIGINAL folder names, in name order", () => {
  const { jobs, looseFiles } = jobFolders(out!.folderPath);
  assert.deepEqual(jobs.map((j) => j.folder).sort(), [MARKUP, "CON", "Job A", "Smith: 123 Main St", "Trailing dot.", "Twin*", "Twin?"].sort());
  for (const j of jobs) assert.ok(fs.existsSync(j.dir), `dir missing for ${j.folder}: ${j.dir}`);
  assert.deepEqual(looseFiles, ["notes|loose.txt"]);
});
check("MUST-PASS: two originals that clean to the same name stay two folders", () => {
  const { jobs } = jobFolders(out!.folderPath);
  const twins = jobs.filter((j) => j.folder.startsWith("Twin"));
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0].dir, twins[1].dir);
});
check("MUST-PASS: a nested unstorable folder is written and its file is there", () => {
  const { jobs } = jobFolders(out!.folderPath);
  const a = jobs.find((j) => j.folder === "Job A")!;
  const nested = fs.readdirSync(a.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.equal(nested.length, 1);
  assert.ok(fs.existsSync(path.join(a.dir, nested[0], "roof.pdf")));
});
check("MUST-EXCLUDE: a zip-slip entry is still never written", () => {
  assert.ok(!fs.existsSync(path.join(path.dirname(out!.folderPath), "escape.pdf")));
  assert.ok(!fs.existsSync(path.join(out!.folderPath, "escape.pdf")));
});
check("MUST-EXCLUDE: a zip whose names are all storable is untouched and writes no manifest", () => {
  const clean = new AdmZip();
  clean.addFile("Job A/planset.pdf", PDF);
  clean.addFile("Job B/planset.pdf", PDF);
  const r = extractZipToWorkdir(clean.toBuffer(), "jobs", "org-test");
  assert.ok(!fs.existsSync(path.join(r.folderPath, ZIP_NAMES_MANIFEST)));
  assert.deepEqual(jobFolders(r.folderPath).jobs.map((j) => j.folder), ["Job A", "Job B"]);
});
check("safeZipSegment: the device names and empty results are made storable", () => {
  assert.equal(safeZipSegment("CON"), "_CON");
  assert.equal(safeZipSegment("com1.txt"), "_com1.txt");
  assert.equal(safeZipSegment("..."), "_");
  assert.equal(safeZipSegment("Job A"), "Job A");
});

removeTempDir(tmp);
if (failures) { console.error(`\n${failures} job-drop zip name check(s) FAILED.`); process.exit(1); }
console.log("\nAll job-drop zip name checks passed.");
