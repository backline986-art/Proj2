// BULK JOB-FOLDER DROP (#538): one zip, one sub-folder per job, one project per folder through
// email intake's per-job pipeline (emailIntake.placeIntakeJob).
//
//   MUST PASS    — the fixture zip (a wrapper folder, four job folders, archive litter, a loose file)
//                  previews as four jobs and queues NOTHING; started, the real job worker gives:
//                  a good folder -> created (under the chosen client and ITS org, plan set and bill
//                  in their slots, the local chain queued), a folder with no readable address ->
//                  unsorted with that reason, a folder at the same address -> attached to that
//                  project, and a folder whose read throws -> retried, while every other folder
//                  still lands (one bad folder never sinks the batch). The drop's list shows every
//                  folder, per org.
//   MUST NOT     — a client of another org is chosen (404, rule 6); a folder job runs for a client
//                  outside its own org, or reads a folder outside its org's upload root; the
//                  extractor is handed anything but the documents' text, or another org than the
//                  client's; a server path reaches the browser.
//
// Synthetic data only: made-up names, example.test domains, generated PDFs. No network: the model
// read is the test seam (AUTOPILOT_TEST_SEAMS=1).
//   npx tsx backend/test/bulkJobDrop.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-drop-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_TEST_SEAMS = "1";
process.env.BATCH_UPLOAD_DIR = path.join(scratch, "uploads");
// Tenant confinement (batchZip.mayScanFolder) only bites with auth on.
process.env.AUTH_ENABLED = "true";
delete process.env.EMAIL_INTAKE_ADDRESS; // the drop never needs the email door switched on
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient } = await import("../src/clients");
const {
  previewUploadedDrop, previewFolderDrop, startDrop, listBulkDrops, runBulkJobFolder, jobFolders, setBulkDropExtractorForTests,
} = await import("../src/bulkJobDrop");
const { drainPendingJobs } = await import("../src/jobQueue");
const { batchUploadRoot } = await import("../src/batchZip");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { default: AdmZip } = await import("adm-zip");

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack || err.message : String(err)}`); }
};
const rejects = async (fn: () => unknown, status: number, label: string): Promise<void> => {
  try { await fn(); } catch (err) { assert.equal((err as { status?: number }).status, status, `${label}: ${(err as Error).message}`); return; }
  assert.fail(`${label}: expected HTTP ${status}, nothing was thrown`);
};

const db = await openDatabase();
const ORG_B = "org-bulk-b";
db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [ORG_B, ORG_B, new Date().toISOString()]);
const acme = createClient(db, { companyName: "Acme Synthetic Solar", businessEmail: "office@acme.example.test" });
const orgBClient = createClient(db, { companyName: "Org B Synthetic Solar", businessEmail: "office@orgb.example.test" }, ORG_B);
const scopeA = { orgId: DEFAULT_ORG_ID, crossOrg: false };
const scopeB = { orgId: ORG_B, crossOrg: false };

async function pdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}

const PLAN_GOOD = await pdf(["PV-1 COVER SHEET", "SOLAR PHOTOVOLTAIC SYSTEM", "Address: 101 Synthetic Way, Salem, OR 97301", "Module model Q.PEAK 400"]);
const PLAN_REV = await pdf(["PV-1 COVER SHEET REV B", "SOLAR PHOTOVOLTAIC SYSTEM", "Address: 101 Synthetic Way, Salem, OR 97301", "Inverter model IQ8PLUS"]);
const PLAN_NO_ADDRESS = await pdf(["PV-1 COVER SHEET", "SOLAR PHOTOVOLTAIC SYSTEM", "Scale 1/8 inch", "Module model Q.PEAK 400"]);
const PLAN_BROKEN = await pdf(["PV-1 COVER SHEET", "SYNTHETIC-THROW", "Address: 303 Fixture Lane, Eugene, OR 97401"]);
const BILL = await pdf(["Your bill", "Billing period Oct 2026", "Amount due $12.34"]);

// THE FIXTURE ZIP (synthetic): zipped from ONE wrapper folder, as a person zips a "Backlog" folder.
function fixtureZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("Backlog/01 Good job/planset.pdf", PLAN_GOOD);
  zip.addFile("Backlog/01 Good job/utility bill.pdf", BILL);
  zip.addFile("Backlog/02 Scanned plans/planset.pdf", PLAN_NO_ADDRESS);
  zip.addFile("Backlog/03 Same address/sub/planset-rev-b.pdf", PLAN_REV);
  zip.addFile("Backlog/04 Broken read/planset.pdf", PLAN_BROKEN);
  zip.addFile("Backlog/04 Broken read/.DS_Store", Buffer.from("litter"));
  zip.addFile("__MACOSX/Backlog/01 Good job/._planset.pdf", Buffer.from("litter"));
  return zip.toBuffer();
}

// The injected model read: what TEXT reached it, and for which org.
const seen: Array<{ input: Record<string, string>; orgId: string }> = [];
setBulkDropExtractorForTests(async (t, orgId) => {
  seen.push({ input: { ...t }, orgId });
  if (t.planText.includes("SYNTHETIC-THROW")) throw new Error("synthetic: model unavailable");
  const street = /Address: ([^,]+), ([^,]+), ([A-Z]{2}) (\d{5})/.exec(t.planText);
  return {
    provider: "claude",
    fields: {
      ...(street ? {
        street: { value: street[1], confidence: 0.95 }, city: { value: street[2], confidence: 0.95 },
        state: { value: street[3], confidence: 0.95 }, zip: { value: street[4], confidence: 0.95 },
      } : {}),
      owner: { value: "Pat Example", confidence: 0.9 },
      utility: { value: "PGE", confidence: 0.9 },
      // A key the parser page never saves: must not steer the client (rule 6).
      client_id: { value: orgBClient.id, confidence: 1 },
    },
    lowConfidenceFields: [],
    notes: "",
  } as never;
});

const bulkJobs = () => db.query<Record<string, unknown>>("SELECT * FROM job_queue WHERE job_type = 'bulk_job_folder' ORDER BY created_at");

let uploadId = "";
await run("the fixture zip previews as four job folders (wrapper unwrapped, litter skipped) and queues nothing", () => {
  const preview = previewUploadedDrop(db, scopeA, acme.id, fixtureZip());
  uploadId = preview.uploadId;
  assert.deepEqual(preview.jobs, [
    { folder: "01 Good job", files: 2 }, { folder: "02 Scanned plans", files: 1 }, { folder: "03 Same address", files: 1 }, { folder: "04 Broken read", files: 1 },
  ]);
  assert.deepEqual(preview.looseFiles, []);
  assert.ok(/^jobs-/.test(uploadId) && !uploadId.includes(path.sep), "an upload id, never a server path");
  assert.ok(!JSON.stringify(preview).includes(scratch), "no server path in the preview");
  assert.equal(bulkJobs().length, 0, "the preview queues nothing");
  assert.equal(seen.length, 0, "the preview reads nothing");
  assert.ok(fs.existsSync(path.join(batchUploadRoot(DEFAULT_ORG_ID), uploadId)), "extracted under the client's org root");
});

await run("rule 6: a client of another org is a 404 at every door; another org's upload id is a 404", async () => {
  await rejects(() => previewUploadedDrop(db, scopeA, orgBClient.id, fixtureZip()), 404, "preview with org B's client");
  await rejects(() => startDrop(db, scopeA, { clientId: orgBClient.id, uploadId }, "op@acme.example.test"), 404, "start with org B's client");
  await rejects(() => startDrop(db, scopeB, { clientId: orgBClient.id, uploadId }, "op@orgb.example.test"), 404, "org B starting org A's upload");
  await rejects(() => startDrop(db, scopeA, { clientId: acme.id, uploadId: "../" + uploadId }, "op"), 404, "an upload id that climbs");
  await rejects(() => startDrop(db, scopeA, { clientId: acme.id }, "op"), 404, "no upload and no folder");
  await rejects(() => previewFolderDrop(db, scopeA, acme.id, scratch), 404, "a tenant naming a server folder outside its root");
  assert.equal(bulkJobs().length, 0);
});

let batchId = "";
await run("start queues one folder job per job folder, each stamped with the chosen client's org", () => {
  const started = startDrop(db, scopeA, { clientId: acme.id, uploadId }, "op@acme.example.test");
  batchId = started.batchId;
  assert.equal(started.queued, 4);
  const jobs = bulkJobs();
  assert.equal(jobs.length, 4);
  for (const j of jobs) {
    assert.equal(j.org_id, DEFAULT_ORG_ID);
    const p = JSON.parse(String(j.payload));
    assert.equal(p.clientId, acme.id);
    assert.equal(p.batchId, batchId);
    assert.equal(p.scanAs, "org");
  }
});

await run("the real worker: created, unsorted (no address), attached (same address), and the broken folder never sinks the batch", async () => {
  // Drain until no folder job is runnable (the broken one waits on its retry backoff).
  for (let i = 0; i < 40; i++) {
    await drainPendingJobs(db);
    const due = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'bulk_job_folder' AND (status = 'running' OR (status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)))",
      [new Date().toISOString()],
    )!;
    if (!Number(due.n)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const [drop] = listBulkDrops(db, DEFAULT_ORG_ID);
  assert.equal(drop.batchId, batchId);
  assert.equal(drop.clientName, "Acme Synthetic Solar");
  assert.equal(drop.total, 4);
  const by = Object.fromEntries(drop.folders.map((f) => [f.folder, f]));
  assert.equal(by["01 Good job"].status, "created");
  assert.equal(by["02 Scanned plans"].status, "unsorted");
  assert.equal(by["02 Scanned plans"].reason, "address_unreadable");
  assert.equal(by["03 Same address"].status, "attached");
  assert.equal(by["03 Same address"].projectId, by["01 Good job"].projectId, "attached to the good folder's project");
  assert.equal(by["04 Broken read"].status, "queued");
  assert.equal(by["04 Broken read"].reason, "retrying");
  assert.deepEqual(drop.counts, { queued: 1, running: 0, created: 1, attached: 1, unsorted: 1 });

  const projectId = String(by["01 Good job"].projectId);
  const project = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId])!;
  assert.equal(project.client_id, acme.id, "the chosen client, never the read's client_id");
  assert.equal(project.org_id, DEFAULT_ORG_ID);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE client_id = ?", [acme.id])!.n, 1, "one project for the one address");
  const docs = db.query<Record<string, unknown>>("SELECT doc_type, original_filename FROM project_documents WHERE project_id = ? AND source = 'bulk_drop' ORDER BY original_filename", [projectId]);
  assert.deepEqual(docs.map((d) => `${d.doc_type}:${d.original_filename}`), ["plan_set:planset-rev-b.pdf", "plan_set:planset.pdf", "utility_bill:utility bill.pdf"]);
  assert.ok(db.get("SELECT id FROM job_queue WHERE job_type = 'stage_step' AND project_id = ?", [projectId]), "the local chain is queued");
  assert.ok(db.get("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'project.created_from_bulk_drop' AND actor_name = ?", [projectId, "op@acme.example.test"]), "the person's name is audited");
  assert.ok(!JSON.stringify(drop).includes(scratch), "no server path in the list");
});

await run("rule 2 + rule 6: the extractor got only the documents' text, for the client's org", () => {
  assert.ok(seen.length >= 4);
  for (const s of seen) {
    assert.deepEqual(Object.keys(s.input).sort(), ["planText", "structuralLetterText", "utilityBillText"]);
    assert.equal(s.orgId, DEFAULT_ORG_ID);
    assert.ok(!JSON.stringify(s.input).includes("Good job"), "never the folder's name");
  }
  const good = seen.find((s) => s.input.planText.includes("101 Synthetic Way") && s.input.utilityBillText.includes("Amount due"));
  assert.ok(good, "the good folder's plan set and bill text reached the read in their slots");
});

await run("the list is per org: org B sees none of org A's drop", () => {
  assert.deepEqual(listBulkDrops(db, ORG_B), []);
  assert.equal(listBulkDrops(db, null).length, 1, "the superadmin reads across orgs");
});

await run("the runner re-checks rule 6: a client outside the job's org, or a folder outside its org root, never runs", async () => {
  const folderPath = path.join(batchUploadRoot(DEFAULT_ORG_ID), uploadId, "Backlog", "01 Good job");
  await assert.rejects(
    () => runBulkJobFolder(db, { id: "j1", orgId: DEFAULT_ORG_ID, payload: { batchId: "x", folder: "f", folderPath, clientId: orgBClient.id, scanAs: "org" } }),
    /no longer in this org/,
  );
  await assert.rejects(
    () => runBulkJobFolder(db, { id: "j2", orgId: ORG_B, payload: { batchId: "x", folder: "f", folderPath, clientId: orgBClient.id, scanAs: "org" } }),
    /Job folder not found/,
  );
});

await run("a single job zipped alone stays one job; loose top-level files are listed, not read", () => {
  const one = path.join(scratch, "single");
  fs.mkdirSync(path.join(one, "12 Elm St"), { recursive: true });
  fs.writeFileSync(path.join(one, "12 Elm St", "plan.pdf"), PLAN_GOOD);
  assert.deepEqual(jobFolders(one).jobs.map((j) => j.folder), ["12 Elm St"]);
  const mixed = path.join(scratch, "mixed");
  fs.mkdirSync(path.join(mixed, "A"), { recursive: true });
  fs.writeFileSync(path.join(mixed, "A", "plan.pdf"), PLAN_GOOD);
  fs.writeFileSync(path.join(mixed, "readme.txt"), "notes");
  const found = jobFolders(mixed);
  assert.deepEqual(found.jobs.map((j) => j.folder), ["A"]);
  assert.deepEqual(found.looseFiles, ["readme.txt"]);
});

await run("an operator (superadmin) may drop a server folder; its jobs are marked operator-queued", () => {
  const root = path.join(scratch, "server-drop");
  fs.mkdirSync(path.join(root, "Job 1"), { recursive: true });
  fs.writeFileSync(path.join(root, "Job 1", "plan.pdf"), PLAN_GOOD);
  const preview = previewFolderDrop(db, { orgId: DEFAULT_ORG_ID, crossOrg: true }, orgBClient.id, root);
  assert.deepEqual(preview.jobs, [{ folder: "Job 1", files: 1 }]);
  const started = startDrop(db, { orgId: DEFAULT_ORG_ID, crossOrg: true }, { clientId: orgBClient.id, folderPath: root }, "admin@keelix.example.test");
  const job = db.get<Record<string, unknown>>("SELECT * FROM job_queue WHERE job_type = 'bulk_job_folder' AND json_extract(payload, '$.batchId') = ?", [started.batchId])!;
  assert.equal(job.org_id, ORG_B, "stamped with the chosen client's org, not the operator's");
  assert.equal(JSON.parse(String(job.payload)).scanAs, "operator");
});

setBulkDropExtractorForTests(null);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
