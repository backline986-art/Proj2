// #569 — THE CONFIRMATION SCREENSHOT OF EVERY FILING, ON THE PROJECT AND THE CARD.
//
// portal-bot reports a MASKED picture of the page the portal confirmed the filing on (RecipeAdapter
// captureConfirmationShot, through #588's maskedFullPageScreenshot; the DOM half is
// portal-bot/src/adapters/confirmationShot.dom.smoke.ts). Pinned here on the REAL prepareSubmission
// (browser stubbed) and a real server:
//   (a) migration v64: submissions.confirmation_document_id.
//   (b) THE POINT — an approved filing the portal ACCEPTED: the picture becomes a project document of
//       type submission_confirmation named by the track and the number read off the page, the filing
//       record links it and says so, and the track card shows "Submitted: <number> · confirmation
//       screenshot" through the project route.
//   (c) a click the portal did NOT confirm: no confirmation document, whatever the run carried; the
//       outcome shot stays the run's picture and the record says it was not confirmed.
//   (d) an accepted filing whose picture the mask refused (no confirmationShotPath): no document, and
//       the record says why no masked screenshot was kept.
//   (e) only a confirmation picture is filed: the unmasked outcome shot's name, or bytes that are not
//       a PNG, are refused.
//   (f) THE HAND-OVER WINDOW: a person's own submit whose page read as the completion — filed under the
//       number read confidently off the page, or "no-number-read" (never a candidate's number); a page
//       that did not read as the completion files nothing.
//   (g) evidence, never a document FOR a filing: no portal upload set carries it, and it does not move
//       the documents-changed clock QC re-judges on.
//   (h) THE ROUTE (rule 6): the project's own submission → 200, the document's bytes; the same
//       submission under ANOTHER project → 404; no picture → 404; a row naming another project's
//       document → 404.
//
// KILL TESTS (run by hand on this tree):
//   K1 repository: drop the saveSubmissionConfirmation call after the outcome → (b) fails.
//   K2 repository: file it for every clicked run, not only acceptedFiling → (c) fails.
//   K3 submissionConfirmationFile: drop `AND sb.project_id = ?` → (h2) fails (200).
//   K4 recordSubmitCapture: name it by capture.recordNumber whatever the confidence → (f2) fails.
//   K5 uploadedSubmissionDocuments: drop the delete → (g) fails.
//
// Run: npx tsx backend/test/submissionConfirmation.test.ts
import "./_isolate"; // FIRST
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setupStageFixture, check, finish } from "./_stageFixture";

process.env.SESSION_ENCRYPTION_KEY = "submission-confirmation-test-key-not-a-secret";
const fx = await setupStageFixture("submission-confirmation");
const { db, repo } = fx;
const conf = await import("../src/submissionConfirmation");
const docsMod = await import("../src/projectDocuments");
const subDocs = await import("../src/submissionDocuments");
const tracks = await import("../src/submittalTracks");

const RECORD = "APP-112491";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "confirmation-shots-"));
let shotSeq = 0;
/** A masked picture as portal-bot writes it: `zzz-confirmation-<label>.png` in the run's folder. */
const shot = (label = "SUBMITTED", bytes?: Buffer): string => {
  const dir = path.join(shotDir, `run-${++shotSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `zzz-confirmation-${label}.png`);
  fs.writeFileSync(p, bytes ?? Buffer.concat([PNG_MAGIC, Buffer.from(`masked confirmation ${shotSeq}`)]));
  return p;
};
const outcomeShot = (): string => {
  const dir = path.join(shotDir, `run-${++shotSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "zzz-outcome-SUBMITTED.png");
  fs.writeFileSync(p, Buffer.concat([PNG_MAGIC, Buffer.from("UNMASKED outcome shot")]));
  return p;
};

const clicked = (verdict: "accepted" | "unknown", extra: Record<string, unknown> = {}) => ({
  portalName: "stub", ok: true, finalSubmitClicked: true, finalSubmitClickedByAutomation: true, pauseReason: null,
  capturedPermitNumber: verdict === "accepted" ? RECORD : "",
  steps: [
    { ok: true, message: "Opened stub portal." },
    { ok: true, message: "the approved final submit was CLICKED", data: { finalSubmitClicked: true, finalSubmitOutcome: { verdict, evidence: null } } },
  ],
  ...extra,
});
const STAGED = {
  portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
  steps: [
    { ok: true, message: "Opened stub portal." },
    { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } },
  ],
};
type Capture = Parameters<NonNullable<Parameters<typeof repo.setRecipeStageRunnerForTests>[0]>>[5] extends infer O
  ? O extends { onSubmitCaptured?: infer F } ? F : never : never;
type CaptureArg = Parameters<NonNullable<Capture>>[0];
const stageWith = async (projectId: string, result: unknown, during?: CaptureArg) => {
  fx.stubRunner(async (_r, _p, _v, _d, _f, o) => {
    if (during) (o?.onSubmitCaptured as Capture)?.(during);
    return result as never;
  });
  await repo.prepareSubmission(db, projectId);
};

const confirmationDocs = (projectId: string) => db.query<Record<string, unknown>>(
  "SELECT * FROM project_documents WHERE project_id = ? AND doc_type = 'submission_confirmation' ORDER BY uploaded_at, rowid", [projectId]);
const newestSubmission = (projectId: string) => db.get<Record<string, unknown>>(
  "SELECT * FROM submissions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [projectId])!;
const cardConfirmations = (projectId: string) => tracks.getSubmittalTracks(db, repo.getProjectDetail(db, projectId).project)
  .map((t) => (t as { confirmation?: { url: string; recordNumber: string; submissionId: string; documentId: string } }).confirmation)
  .filter(Boolean);

fx.completeRecipe();

await check("(a) migration v64: submissions.confirmation_document_id", () => {
  const cols = db.query<{ name: string }>("PRAGMA table_info(submissions)").map((c) => c.name);
  assert.ok(cols.includes("confirmation_document_id"), cols.join(","));
});

let ownPid = "";
let ownSubmission = "";
let ownFile = "";
await check("(b) THE POINT: an accepted approved filing files the masked picture, named by the number read, linked from the record and the card", async () => {
  ownPid = fx.newProject();
  const p = shot();
  await stageWith(ownPid, clicked("accepted", { confirmationShotPath: p, outcomeShotPath: outcomeShot() }));
  assert.equal(fx.latestRun(ownPid)!.status, "submitted");
  const docs = confirmationDocs(ownPid);
  assert.equal(docs.length, 1, `expected one confirmation document, found ${docs.length}`);
  assert.equal(docs[0].original_filename, `permit-confirmation-${RECORD}.png`);
  assert.equal(docs[0].content_type, "image/png");
  assert.deepEqual(fs.readFileSync(String(docs[0].stored_path)), fs.readFileSync(p), "the document is not the run's masked picture");
  const sub = newestSubmission(ownPid);
  assert.equal(sub.status, "submitted");
  assert.equal(sub.confirmation_document_id, docs[0].id, "the filing record does not link the picture");
  assert.match(String(sub.notes), /Confirmation screenshot \(secrets masked\) saved/);
  ownSubmission = String(sub.id);
  ownFile = String(docs[0].stored_path);
  const cards = cardConfirmations(ownPid);
  assert.equal(cards.length >= 1, true, "no track card shows the confirmation");
  assert.equal(cards[0]!.recordNumber, RECORD);
  assert.equal(cards[0]!.url, `/api/projects/${ownPid}/submissions/${ownSubmission}/confirmation-screenshot`);
  assert.equal(conf.submissionConfirmationFile(db, ownPid, ownSubmission), ownFile);
});

await check("(c) a click the portal did NOT confirm files no confirmation; the outcome shot stays, the record says unconfirmed", async () => {
  const pid = fx.newProject();
  const outcome = outcomeShot();
  await stageWith(pid, clicked("unknown", { confirmationShotPath: shot(), outcomeShotPath: outcome }));
  assert.equal(fx.latestRun(pid)!.status, "submitted_unconfirmed");
  assert.equal(confirmationDocs(pid).length, 0, "an unconfirmed click was given a confirmation screenshot");
  assert.equal(fx.latestRun(pid)!.screenshots_path, outcome, "the outcome shot is not kept on the run");
  const sub = newestSubmission(pid);
  assert.equal(sub.confirmation_document_id, "");
  assert.match(String(sub.notes), /did not confirm the filing/);
  assert.equal(cardConfirmations(pid).length, 0);
});

await check("(d) an accepted filing whose picture the mask refused: no document, and the record says why", async () => {
  const pid = fx.newProject();
  await stageWith(pid, clicked("accepted", { confirmationShotRefused: "the page holds a closed shadow root", outcomeShotPath: outcomeShot() }));
  assert.equal(fx.latestRun(pid)!.status, "submitted");
  assert.equal(confirmationDocs(pid).length, 0);
  assert.match(String(newestSubmission(pid).notes), /No masked confirmation screenshot was kept \(the page holds a closed shadow root\); the completion page is the run's outcome shot/);
});

await check("(e) only a confirmation picture is filed: the unmasked outcome shot's name, or non-PNG bytes, are refused", async () => {
  const pid = fx.newProject();
  await stageWith(pid, clicked("accepted", { confirmationShotPath: outcomeShot() }));
  assert.equal(confirmationDocs(pid).length, 0, "the unmasked outcome shot was filed as the confirmation");
  const pid2 = fx.newProject();
  await stageWith(pid2, clicked("accepted", { confirmationShotPath: shot("SUBMITTED", Buffer.from("<html>not a picture</html>")) }));
  assert.equal(confirmationDocs(pid2).length, 0, "a file that is not a PNG was filed");
  assert.match(String(newestSubmission(pid2).notes), /not a PNG/);
  // A submission of another project is never linked.
  const r = conf.saveSubmissionConfirmation(db, { projectId: pid, submissionId: ownSubmission, track: "permit", recordNumber: RECORD, shotPath: shot(), filedBy: "automation", runId: "x" });
  assert.equal(r.documentId, null);
});

await check("(f1) the hand-over: a person's submit read as the completion, number read confidently → filed under that number", async () => {
  const pid = fx.newProject();
  const p = shot("PERSON_SUBMITTED");
  await stageWith(pid, STAGED, { recordNumber: "APP-990001", confidence: "high", source: "completion_page", reason: "Captured submission confirmation: APP-990001.", recordLink: "", completionConfirmed: true, confirmationShotPath: p });
  const docs = confirmationDocs(pid);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].original_filename, "permit-confirmation-APP-990001.png");
  assert.match(String(docs[0].uploaded_by), /your submit in the review window/);
  const run = fx.latestRun(pid)!;
  const linked = db.get<Record<string, unknown>>("SELECT * FROM submissions WHERE confirmation_document_id = ?", [docs[0].id]);
  assert.ok(linked && linked.project_id === pid, "the picture is not linked from this project's filing record");
  assert.equal(String(run.status), "submitted");
});

await check("(f2) the hand-over: completion read, no confident number (a list candidate) → \"no-number-read\", never the candidate's number", async () => {
  const pid = fx.newProject();
  await stageWith(pid, STAGED, {
    recordNumber: "", confidence: "low", source: "none", reason: "Submitted; no record number found on the completion page yet.", recordLink: "",
    candidates: [{ recordNumber: "APP-555555", recordLink: "", source: "account_list" }], completionConfirmed: true, confirmationShotPath: shot("PERSON_SUBMITTED"),
  });
  const docs = confirmationDocs(pid);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].original_filename, "permit-confirmation-no-number-read.png");
  assert.ok(!String(docs[0].original_filename).includes("555555"));
  const cards = cardConfirmations(pid);
  assert.equal(cards.length >= 1 && cards[0]!.recordNumber, "", "the card claims a number nobody read");
});

await check("(f3) the hand-over: a page that did NOT read as the completion files nothing", async () => {
  const pid = fx.newProject();
  await stageWith(pid, STAGED, { recordNumber: "", confidence: "low", source: "none", reason: "This page does not read as the application's completion.", recordLink: "", confirmationShotPath: shot("PERSON_SUBMITTED") });
  assert.equal(confirmationDocs(pid).length, 0);
});

await check("(g) evidence, not a document for a filing: no upload set carries it; the documents clock does not move", async () => {
  const project = repo.getProjectDetail(db, ownPid).project;
  assert.ok(!("submission_confirmation" in subDocs.uploadedSubmissionDocuments(db, project)), "a confirmation screenshot is in the portal upload set");
  for (const track of [null, "nem", "building"] as const) {
    assert.ok(!("submission_confirmation" in subDocs.submissionDocumentsByType(db, project, track)), `track ${String(track)} would upload it`);
  }
  const before = docsMod.documentsChangedAt(db, ownPid);
  await new Promise((r) => setTimeout(r, 5));
  const again = conf.saveSubmissionConfirmation(db, { projectId: ownPid, submissionId: ownSubmission, track: "permit", recordNumber: RECORD, shotPath: shot(), filedBy: "automation", runId: "g" });
  assert.ok(again.documentId, again.why);
  assert.equal(docsMod.documentsChangedAt(db, ownPid), before, "a confirmation screenshot moved the documents-changed clock");
  ownFile = String(conf.submissionConfirmationFile(db, ownPid, ownSubmission));
});

// (h) the route, on a real server over the same scratch DB.
const otherPid = fx.newProject();
const forgedPid = fx.newProject();
await stageWith(forgedPid, clicked("accepted", { confirmationShotPath: shot() }));
const forgedSubmission = String(newestSubmission(forgedPid).id);
// Point the forged project's record at ANOTHER project's document.
const ownDocId = String(newestSubmission(ownPid).confirmation_document_id);
db.run("UPDATE submissions SET confirmation_document_id = ? WHERE id = ?", [ownDocId, forgedSubmission]);

const dbPath = String(process.env.AUTOPILOT_DB_PATH);
const PORT = 5460 + Math.floor(Math.random() * 15); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  AUTH_ENABLED: "false", NO_PROXY: "*", no_proxy: "*", AUTOPILOT_TEST_SEAMS: "",
};
delete env.PORTAL_ALLOW_FINAL_SUBMIT;
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  const get = (p: string) => fetch(`${BASE}${p}`);
  await check("(h1) the project's own filing → 200, the masked document's bytes, inline PNG", async () => {
    const res = await get(`/api/projects/${ownPid}/submissions/${ownSubmission}/confirmation-screenshot`);
    assert.equal(res.status, 200, await res.clone().text().catch(() => ""));
    assert.match(String(res.headers.get("content-type")), /image\/png/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(ownFile));
  });
  await check("(h2) rule 6: the same submission under ANOTHER project → 404", async () => {
    const res = await get(`/api/projects/${otherPid}/submissions/${ownSubmission}/confirmation-screenshot`);
    assert.equal(res.status, 404, `MUST-EXCLUDE: another project's confirmation was served (${res.status})`);
  });
  await check("(h3) no picture, or no such submission → 404", async () => {
    assert.equal((await get(`/api/projects/${otherPid}/submissions/no-such-submission/confirmation-screenshot`)).status, 404);
    const bare = String(newestSubmission(otherPid)?.id ?? "none");
    assert.equal((await get(`/api/projects/${otherPid}/submissions/${bare}/confirmation-screenshot`)).status, 404);
  });
  await check("(h4) a record naming ANOTHER project's document → 404", async () => {
    assert.equal((await get(`/api/projects/${forgedPid}/submissions/${forgedSubmission}/confirmation-screenshot`)).status, 404, "another project's document was served through this project's record");
  });
} finally {
  server.kill("SIGTERM");
}

finish("submission-confirmation");
