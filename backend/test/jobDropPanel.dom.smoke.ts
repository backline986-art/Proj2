// NEW JOBS FROM A ZIP, ON SCREEN — real Chromium, the real dashboard, a real server (#538 part 2).
//
// bulkJobDrop.test.ts proves the runner. This proves a person can drive it from the dashboard:
//   1. Choose the client, choose a zip: the panel lists its job folders and the count, and NOTHING
//      is queued until Start (the count is seen before any model read).
//   2. Start: one job per folder is queued and the drop appears in the list, then every folder
//      ends with its outcome and reason (this server has no model key, so the read finds no
//      address and each folder lands "Needs a person" with that reason, which is still a real
//      end-to-end outcome through the shipped pipeline).
//   3. Folder names come from the archive: one named like markup is shown as text, never run.
//
// Discovered by scripts/run-dom-smokes.ts (*.dom.smoke.ts). Direct:
//   npx tsx backend/test/jobDropPanel.dom.smoke.ts
// Synthetic data only; the page is kept off the network (every non-local request is aborted).
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { REPO } from "./_isolate";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "job-drop-dom-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.log(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack || err.message : String(err)}`); }
};

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { default: AdmZip } = await import("adm-zip");
const db = await openDatabase();
const client = createClient(db, { companyName: "Dropzone Synthetic Solar", businessEmail: "office@dropzone.example.test" });
const bulkJobs = () => db.query<Record<string, unknown>>("SELECT org_id, status FROM job_queue WHERE job_type = 'bulk_job_folder'");

async function pdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}
const PLAN = await pdf(["PV-1 COVER SHEET", "SOLAR PHOTOVOLTAIC SYSTEM", "Address: 101 Synthetic Way, Salem, OR 97301"]);
const MARKUP_FOLDER = "<img src=x onerror=window.__pwned=1>";
const zip = new AdmZip();
zip.addFile("Job A/planset.pdf", PLAN);
zip.addFile("Job B/planset.pdf", PLAN);
zip.addFile(`${MARKUP_FOLDER}/planset.pdf`, PLAN);
const zipPath = path.join(tmp, "backlog.zip");
fs.writeFileSync(zipPath, zip.toBuffer());

const PORT = 5446 + Math.floor(Math.random() * 15); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: process.env.AUTOPILOT_DB_PATH, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "false", NO_PROXY: "*", no_proxy: "*", AUTOPILOT_TEST_SEAMS: "",
  BATCH_UPLOAD_DIR: path.join(tmp, "uploads"),
  // The isolated cwd has no frontend/: serve the REAL shipped files.
  FRONTEND_DIR: path.join(REPO, "frontend"),
};
delete env.PORTAL_ALLOW_FINAL_SUBMIT;
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  await ctx.route("**/*", (route) => (route.request().url().startsWith(BASE) ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${BASE}/#/dashboard`);
  // The Knowledge button lives in the header's overflow menu; press it as the menu would.
  await page.waitForFunction(() => !!document.getElementById("openKnowledgeBtn"));
  await page.evaluate(() => document.getElementById("openKnowledgeBtn")!.click());
  await page.waitForSelector("#jobDropPanel", { state: "visible" });
  await page.waitForFunction((id) => !!document.querySelector(`#jobDropClient option[value="${id}"]`), client.id, { timeout: 30_000 });

  await check("1. a chosen zip lists its job folders and the count, and queues nothing until Start", async () => {
    await page.selectOption("#jobDropClient", client.id);
    await page.setInputFiles("#jobDropInput", zipPath);
    await page.waitForSelector("#jobDropPreview:not([hidden])", { timeout: 30_000 });
    const preview = await page.textContent("#jobDropPreview");
    assert.match(preview || "", /3 job folders for Dropzone Synthetic Solar/);
    assert.match(preview || "", /Job A \(1 file\)/);
    assert.match(preview || "", /3 reads in all/);
    assert.equal(bulkJobs().length, 0, "the preview queued jobs");
  });

  await check("2. Start queues one job per folder; every folder ends with its outcome and reason", async () => {
    await page.click("#jobDropPreview button.primary");
    await page.waitForFunction(() => /Dropzone Synthetic Solar: 3 jobs/.test(document.getElementById("jobDropList")?.textContent || ""), null, { timeout: 30_000 });
    assert.equal(bulkJobs().length, 3);
    // The list refreshes itself (every 5s) until no folder is waiting or being read.
    await page.waitForFunction(() => /\(3\/3 done/.test(document.getElementById("jobDropList")?.textContent || ""), null, { timeout: 120_000 });
    const list = await page.textContent("#jobDropList");
    assert.match(list || "", /Job A: Needs a person/);
    assert.match(list || "", /project address could not be read/);
    assert.equal(await page.isHidden("#jobDropPreview"), true, "the preview stays open after Start");
  });

  await check("3. a folder named like markup is shown as text and never run", async () => {
    const list = await page.textContent("#jobDropList");
    assert.ok((list || "").includes(MARKUP_FOLDER), "the markup-named folder is not listed as text");
    assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined, "the folder name ran as markup");
    assert.equal(await page.locator("#jobDropList img").count(), 0);
  });

  await check("the page threw no errors", async () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser.close().catch(() => null);
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\njob-drop-panel-dom: all checks passed");
process.exit(failures ? 1 : 0);
