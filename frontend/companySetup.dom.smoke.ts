// THE CLIENT'S COMPANY SETUP PAGE — real Chromium, the REAL server on a scratch database, synthetic data.
//
// frontend/onboarding.html over backend/src/clientOnboarding.ts:
//   MUST PASS    — a staff-minted link opens the page with the company's name and its questions;
//   MUST PASS    — typed answers (a field, a licence row, a service-area row) save as a draft and are
//                  still there after a reload (works across sessions);
//   MUST PASS    — the "Still missing" checklist shrinks as answers arrive;
//   MUST PASS    — Send closes the page, and the answers wait as proposals: the client record is unchanged;
//   MUST PASS    — the portal hand-off returns a /credentials one-time link (the existing flow);
//   MUST EXCLUDE — a password box anywhere on the page; a dead / unknown link showing the form.
//
// Boots backend/src/server.ts (sign-in off, its own port band 6170-6179, scratch DB). Invented places only.
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/companySetup.dom.smoke.ts`
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

function freePortInBand(start: number, count: number): number {
  for (let i = 0; i < count; i++) {
    try {
      execFileSync(process.execPath, ["-e", `require("net").createServer().listen(${start + i},"0.0.0.0",function(){this.close()}).on("error",()=>process.exit(1))`], { stdio: "ignore" });
      return start + i;
    } catch { /* held */ }
  }
  return start + Math.floor(Math.random() * count);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-dom-"));
const PORT = freePortInBand(6170, 10);
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: path.join(tmp, "test.sqlite"),
  PROJECT_DOCS_DIR: path.join(tmp, "docs"),
  BACKUP_DIR: path.join(tmp, "backups"),
  BATCH_UPLOAD_DIR: path.join(tmp, "batch-uploads"),
  BATCH_REPORT_DIR: path.join(tmp, "batch-reports"),
  AUTOPILOT_LOG_FILE: path.join(tmp, "backend.log"),
  AUTOPILOT_AUTO_START: "0",
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "",
  SESSION_ENCRYPTION_KEY: "onboarding-dom-key-not-a-real-secret",
  AUTH_ENABLED: "false",
  PUBLIC_BASE_URL: BASE,
  NO_PROXY: "*", no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL", "SMTP_HOST"]) delete env[k];

const api = async (p: string, init: RequestInit = {}): Promise<any> => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(body)}`);
  return body;
};

async function main(): Promise<void> {
  const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), "backend/src/server.ts"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout?.on("data", (d) => { log += String(d); });
  server.stderr?.on("data", (d) => { log += String(d); });
  // Launched INSIDE the try: a browser that will not start must still kill the server, or the smoke
  // hangs to its budget instead of exiting red.
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    for (let i = 0; i < 90; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up */ }
      if (i === 89) throw new Error(`server never came up:\n${log.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const client = await api("/api/clients", { method: "POST", body: JSON.stringify({ companyName: "Larchmere Solar (TEST)", businessCity: "Old Town" }) });
    const minted = await api(`/api/clients/${client.id}/onboarding-links`, { method: "POST", body: JSON.stringify({ decidedBy: "Pat Operator" }) });
    const url = String(minted.url);

    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await ctx.addInitScript("globalThis.__name = (f) => f;");
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e: Error) => pageErrors.push(e.message));
    await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
      route.request().url().startsWith(BASE) ? route.continue() : route.abort());

    // A dead link shows no form.
    await page.goto(`${BASE}/onboarding?token=${"n".repeat(43)}`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.classList.contains("ob-closed"), null, { timeout: 15000 });
    check(/can’t be used/.test(await page.textContent("#heroTitle") || ""), "an unknown link says it cannot be used and shows no form");

    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector("#f_businessCity", { timeout: 15000 });
    check(/Larchmere Solar \(TEST\)/.test(await page.textContent("#heroTitle") || ""), "the page names the company");
    check(await page.inputValue("#f_businessCity") === "Old Town", "what is on file is shown");
    check(await page.locator("input[type=password]").count() === 0, "no password box anywhere on the page");
    const missingBefore = await page.locator("#checklist li").count();
    check(missingBefore > 3, "the checklist lists what is missing", String(missingBefore));

    await page.fill("#f_standardDisconnectMake", "Examplecorp");
    await page.fill("#f_standardDisconnectModel", "EX-30");
    await page.click("#addLicBtn");
    await page.fill('[data-lic-row="0"] [data-lic="state"]', "ZZ");
    await page.selectOption('[data-lic-row="0"] [data-lic="kind"]', "contractor");
    await page.fill('[data-lic-row="0"] [data-lic="number"]', "ZZ-C-4471");
    await page.click("#addAreaBtn");
    await page.fill('[data-area-row="0"] [data-area="state"]', "ZZ");
    await page.fill('[data-area-row="0"] [data-area="name"]', "Fernhollow");
    await page.click("#saveBtn");
    await page.waitForFunction(() => /Saved/.test(document.getElementById("status")?.textContent || ""), null, { timeout: 10000 })
      .catch(async () => check(false, "Save for later saves", await page.textContent("#status") || ""));
    const missingAfter = await page.locator("#checklist li").count();
    check(missingAfter < missingBefore, "the checklist shrinks as answers arrive", `${missingBefore} → ${missingAfter}`);

    // HOW YOU FILE IN EACH PLACE: the saved place is listed; the row takes an address, a yes/no and an
    // example number, and nothing that could hold a login.
    await page.waitForSelector("#filingList [data-filing-row]", { timeout: 10000 }).catch(() => undefined);
    check(await page.locator("#filingList [data-filing-row]").count() === 1, "the place just saved is listed under How you file", await page.textContent("#filingCard") || "");
    check(/Fernhollow/.test(await page.textContent("#filingList [data-filing-row]") || ""), "the filing row names the place");
    check(await page.locator("#filingCard input[type=password]").count() === 0 && await page.locator("#filingList [data-filing-row] input").count() === 2, "a filing row has an address and an example number, no login field");
    await page.fill('#filingList [data-filing="address"]', "permits.fernhollow.example.gov/apply");
    await page.selectOption('#filingList [data-filing="account"]', "yes");
    await page.fill('#filingList [data-filing="example"]', "BLD-2026-00123");
    await page.click("#saveBtn");
    await page.waitForFunction(() => /^Saved\. You can come back/.test(document.getElementById("status")?.textContent || ""), null, { timeout: 10000 })
      .catch(async () => check(false, "the filing answer saves without a problem", await page.textContent("#status") || ""));

    // Across sessions: a fresh page on the same link shows the draft.
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#f_businessCity", { timeout: 15000 });
    const persisted = {
      make: await page.inputValue("#f_standardDisconnectMake"),
      lic: await page.inputValue('[data-lic-row="0"] [data-lic="number"]'),
      area: await page.inputValue('[data-area-row="0"] [data-area="name"]'),
      filing: await page.inputValue('#filingList [data-filing="address"]').catch(() => ""),
      account: await page.inputValue('#filingList [data-filing="account"]').catch(() => ""),
    };
    check(persisted.make === "Examplecorp" && persisted.lic === "ZZ-C-4471" && persisted.area === "Fernhollow", "the draft survives a reload", JSON.stringify(persisted));
    check(persisted.filing === "permits.fernhollow.example.gov/apply" && persisted.account === "yes", "the filing answer survives a reload", JSON.stringify(persisted));

    // Portal hand-off: the existing one-time credential link.
    await page.fill('#portalList [data-portal="name"]', "Fernhollow permits");
    await page.fill('#portalList [data-portal="url"]', "https://permits.fernhollow.example.gov/login");
    await page.click("#portalLinkBtn");
    await page.waitForSelector("#portalLinkHref", { timeout: 10000 });
    const href = await page.getAttribute("#portalLinkHref", "href") || "";
    check(/\/credentials\?token=[a-f0-9]{64}$/.test(href), "the portal hand-off gives a one-time /credentials link", href);

    await page.click("#submitBtn");
    await page.waitForFunction(() => document.body.classList.contains("ob-closed"), null, { timeout: 15000 });
    check(/review/i.test(await page.textContent("#heroTitle") || ""), "Send closes the page and says a person reviews it");

    const after = await api(`/api/clients/${client.id}/onboarding`);
    const fields = after.proposals.map((p: { field: string }) => p.field).sort();
    check(JSON.stringify(fields) === JSON.stringify(["serviceArea", "standardDisconnectMake", "standardDisconnectModel", "stateLicenses"]), "the answers wait as client-supplied proposals", JSON.stringify(fields));
    const said = (after.filingStatements || []).map((f: { kind: string; address: string; hasAccount: string; example: string }) => [f.kind, f.address, f.hasAccount, f.example]);
    check(JSON.stringify(said) === JSON.stringify([["portal", "https://permits.fernhollow.example.gov/apply", "yes", "BLD-2026-00123"]]), "the filing answer is kept as the client's word", JSON.stringify(said));
    const kbRows = JSON.stringify(await api("/api/knowledge-base"));
    check(kbRows.length > 2 && !kbRows.includes("permits.fernhollow.example.gov"), "the client's address is in no knowledge row", kbRows.slice(0, 120));
    const record = (await api("/api/clients")).clients.find((c: { id: string }) => c.id === client.id);
    check(record.standardDisconnectMake === "" && (record.stateLicenses || []).length === 0, "the client record is unchanged until a person accepts", JSON.stringify({ make: record.standardDisconnectMake, lic: record.stateLicenses }));
    check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
    await ctx.close();
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS cleans tmp */ }
  }
  console.log(failures.length ? `\nCOMPANY SETUP PAGE: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nCOMPANY SETUP PAGE: all checks passed.");
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
