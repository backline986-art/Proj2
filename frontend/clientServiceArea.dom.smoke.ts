// CLIENT SERVICE AREA EDITOR — real Chromium, the dashboard's own markup, script and stylesheet.
//
// Clients → Service area (dashboard.js renderServiceArea / serviceAreaPayload / withServiceArea):
//   MUST PASS — the stored entries render one row each (kind, state, name; a whole-state row has no name);
//   MUST PASS — Save sends the editor's FULL list as `serviceArea` (an added row included, a removed one gone);
//   MUST PASS — a half-filled row (a city with no name) blocks the save with its reason: nothing is sent;
//   MUST PASS — a client whose list was never loaded into the editor (a NEW client) sends exactly what was
//               typed for it, and the stored list of the client edited before is never sent for it.
//
// Hermetic: a throwaway static server over frontend/, stubbed /api/clients (invented places only), the
// PUT / POST bodies captured, everything else 404. No backend, no database.
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/clientServiceArea.dom.smoke.ts`
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const FRONTEND = path.dirname(fileURLToPath(import.meta.url));
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const CLIENT = {
  id: "client-area-1", companyName: "Area Editor Solar (TEST)", portalIdentities: [], stateLicenses: [],
  serviceArea: [
    { kind: "state", state: "ZZ", name: "" },
    { kind: "city", state: "ZZ", name: "Fernhollow" },
    { kind: "utility", state: "ZZ", name: "Brightwater Valley Electric" },
  ],
};
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };
const sent: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];

const startServer = async (): Promise<{ base: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname.startsWith("/api/")) {
      if ((req.method === "PUT" || req.method === "POST") && /^\/api\/clients(\/[^/]+)?$/.test(url.pathname)) {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          const body = JSON.parse(raw || "{}");
          sent.push({ method: req.method!, path: url.pathname, body });
          json({ ...CLIENT, ...body, id: req.method === "POST" ? "client-area-new" : CLIENT.id });
        });
        return;
      }
      if (url.pathname === "/api/projects") return json({ projects: [], total: 0 });
      if (url.pathname === "/api/clients") return json({ clients: [CLIENT] });
      if (/^\/api\/clients\/[^/]+\/portal-credentials$/.test(url.pathname)) return json({ credentials: [] });
      if (/^\/api\/users/.test(url.pathname)) return json({ users: [] });
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not stubbed"}');
      return;
    }
    const name = url.pathname === "/" ? "dashboard.html" : url.pathname.replace(/^\/+/, "");
    const file = path.join(FRONTEND, name);
    if (file.startsWith(FRONTEND) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

async function main(): Promise<void> {
  const { base, close } = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript("globalThis.__name = (f) => f;");
    const page = await ctx.newPage();
    page.on("dialog", (d: { dismiss(): Promise<void> }) => d.dismiss());
    await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(`${base}/#/dashboard`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(400);
    await page.evaluate(() => (document.getElementById("openClientsBtn") as HTMLButtonElement).click());
    await page.waitForSelector(`[data-client-id="client-area-1"]`, { timeout: 15000 });
    await page.evaluate(() => (document.querySelector(`[data-client-id="client-area-1"]`) as HTMLButtonElement).click());
    await page.waitForSelector("#serviceAreaList .service-area-row", { timeout: 15000 });

    const rows = await page.evaluate(() => [...document.querySelectorAll("#serviceAreaList .service-area-row")].map((r) => ({
      kind: (r.querySelector('[data-sa="kind"]') as HTMLSelectElement).value,
      state: (r.querySelector('[data-sa="state"]') as HTMLInputElement).value,
      name: (r.querySelector('[data-sa="name"]') as HTMLInputElement).value,
      nameDisabled: (r.querySelector('[data-sa="name"]') as HTMLInputElement).disabled,
    })));
    check(rows.length === 3, "the three stored entries render one row each", JSON.stringify(rows));
    check(rows[0].kind === "state" && rows[0].nameDisabled && rows[1].name === "Fernhollow" && rows[2].kind === "utility", "kind, state and name are shown; a whole-state row has no name", JSON.stringify(rows));

    // A half-filled row blocks the save: nothing is sent.
    await page.click("#addServiceAreaBtn");
    await page.fill('#serviceAreaList [data-sa-row="3"] [data-sa="state"]', "ZZ");
    await page.evaluate(() => (document.querySelector('#clientForm button[type="submit"]') as HTMLButtonElement).click());
    await page.waitForTimeout(300);
    const status = await page.evaluate(() => document.getElementById("clientFormStatus")?.textContent || "");
    check(sent.length === 0, "a city row with no name sends nothing", JSON.stringify(sent));
    check(/Service area row 4: name the city/.test(status), "the reason is shown", status);

    // Fill it, remove the utility row, save: the FULL edited list goes out.
    await page.fill('#serviceAreaList [data-sa-row="3"] [data-sa="name"]', "Alderbank");
    await page.evaluate(() => (document.querySelector('#serviceAreaList [data-remove-sa="2"]') as HTMLButtonElement).click());
    await page.evaluate(() => (document.querySelector('#clientForm button[type="submit"]') as HTMLButtonElement).click());
    await page.waitForTimeout(500);
    const put = sent.find((s) => s.method === "PUT");
    check(!!put && put.path === "/api/clients/client-area-1", "Save sends PUT /api/clients/:id", JSON.stringify(sent));
    check(JSON.stringify(put?.body.serviceArea) === JSON.stringify([
      { kind: "state", state: "ZZ", name: "" }, { kind: "city", state: "ZZ", name: "Fernhollow" }, { kind: "city", state: "ZZ", name: "Alderbank" },
    ]), "the full edited list is sent (added row in, removed row out)", JSON.stringify(put?.body.serviceArea));

    // A new client: the previous client's list is never sent for it.
    sent.length = 0;
    await page.click("#newClientBtn");
    await page.waitForTimeout(200);
    await page.fill("#c_companyName", "New Area Solar (TEST)");
    await page.evaluate(() => (document.querySelector('#clientForm button[type="submit"]') as HTMLButtonElement).click());
    await page.waitForTimeout(500);
    const post = sent.find((s) => s.method === "POST");
    check(!!post, "a new client is created with POST", JSON.stringify(sent));
    check(!post || !JSON.stringify(post.body).includes("Fernhollow"), "the previous client's service area is not sent for a new one", JSON.stringify(post?.body));
    await ctx.close();
  } finally {
    await browser.close();
    await close();
  }
  console.log(failures.length ? `\nCLIENT SERVICE AREA EDITOR: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nCLIENT SERVICE AREA EDITOR: all checks passed.");
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
