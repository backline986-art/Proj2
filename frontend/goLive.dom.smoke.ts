// =================================================================================================
// THE GO-LIVE CHECK VIEW (owner, 2026-11-10; GET /api/go-live, frontend/go-live.js).
//
// The whole shipped dashboard.js runs here in real Chromium against a stubbed /api (synthetic data,
// sign-in off).
//   [O] the toolbar button opens the Go-live check and reads GET /api/go-live once;
//   [V] each line shows its state, label and meaning, settings only as set / not set, blockers first in
//       the summary; text from the server is escaped (a hostile label renders as text);
//   [D] "Open Destinations to confirm" closes the view and opens that view (GET /api/filing-destinations);
//   [W] opening, refreshing and closing it sends no write of any kind;
//   [E] Esc closes it.
//
// Discovered from disk by scripts/run-dom-smokes.ts: `npm run portal:test:dom`.
// Alone: `npx tsx frontend/goLive.dom.smoke.ts`
// =================================================================================================
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.DASHBOARD_REPO_DIR || path.resolve(HERE, "..");
const FRONTEND = process.env.DASHBOARD_FRONTEND_DIR || path.join(REPO, "frontend");
const require = createRequire(path.join(REPO, "package.json"));
const { chromium } = require("playwright");

let passed = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log(`  ok   - ${label}`); }
  else { failures.push(label); console.log(`  FAIL - ${label}${detail ? `\n         ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
  return fn();
}

const report = {
  generatedAt: "2026-11-10T12:00:00.000Z", source: "server", orgId: "org-default", ready: false,
  counts: { red: 1, warn: 1, off: 1, ok: 1 },
  lines: [
    { id: "public-base-url", area: "client", label: "Client link address", state: "red",
      meaning: "PUBLIC_BASE_URL is not set, so every client link would point at this machine (localhost). Every client email with a link is held as a draft instead of mailing a dead link.",
      settings: [{ name: "PUBLIC_BASE_URL", set: false }] },
    { id: "final-submit", area: "filing", label: "Automatic portal submit", state: "off",
      meaning: "Off: automation never clicks a portal's final submit. A person submits every filing.", settings: [{ name: "PORTAL_ALLOW_FINAL_SUBMIT", set: false }] },
    { id: "session-key", area: "access", label: "<img src=x onerror=alert(1)>", state: "ok", meaning: "Set.", settings: [{ name: "SESSION_ENCRYPTION_KEY", set: true }] },
    { id: "destinations", area: "data", label: "Filing destinations to confirm", state: "warn", view: "destinations",
      meaning: "2 authority(ies) an open job files with have no person-verified destination, so nothing files there automatically (1 can be confirmed in one click).", settings: [] },
  ],
  other: [{ name: "LOG_LEVEL", set: true }, { name: "DEBUG", set: false }],
};
const queuePayload = { clients: [], counts: { jobs: 0, authorities: 0, oneClick: 0, editOnly: 0, noProposal: 0, handCheck: 0, alreadyVerified: 0 } };

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml" };

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  const counts = { goLive: 0, queue: 0 };
  const writesAfterOpen: string[] = [];
  let opened = false;
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(String(e && e.message || e)));
  const dialogs: string[] = [];
  page.on("dialog", async (d: { message(): string; dismiss(): Promise<void> }) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.route("**/*", async (route: any) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (u.hostname === "dash.test" && !p.startsWith("/api") && p !== "/health") {
      const f = path.join(FRONTEND, p === "/" ? "dashboard.html" : p.slice(1));
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: "" });
    }
    if (u.hostname !== "dash.test") return route.abort();
    if (opened && req.method() !== "GET") writesAfterOpen.push(`${req.method()} ${p}`);
    if (p === "/health") return json({ ok: true });
    if (p === "/api/events") return route.abort();
    if (p === "/api/auth/me") return json({ enabled: false, user: null });
    if (p === "/api/projects") return json({ projects: [], total: 0 });
    if (p === "/api/go-live") { counts.goLive++; return json(report); }
    if (p === "/api/filing-destinations") { counts.queue++; return json(queuePayload); }
    if (p === "/api/users") return json([]);
    if (p === "/api/clients") return json({ clients: [] });
    return json({});
  });

  await page.goto("http://dash.test/dashboard.html", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#openGoLiveBtn", { state: "attached", timeout: 20000 });
  await sleep(500);

  console.log("\n[O] open");
  opened = true;
  await page.evaluate(() => { (document.getElementById("openGoLiveBtn") as HTMLButtonElement).click(); });
  const first = await page.waitForSelector('#goLiveBody [data-golive-line="public-base-url"]', { state: "visible", timeout: 15000 }).catch(() => null);
  check("the toolbar button opens the Go-live check and reads GET /api/go-live", Boolean(first) && counts.goLive === 1, `GETs ${counts.goLive}; ${pageErrors.slice(0, 2).join(" | ")}`);

  console.log("\n[V] the view");
  const view = await page.evaluate(() => {
    const body = document.getElementById("goLiveBody")!;
    const lineOf = (id: string) => body.querySelector(`[data-golive-line="${id}"]`) as HTMLElement | null;
    return {
      summary: (body.querySelector(".golive-summary")?.textContent || "").replace(/\s+/g, " ").trim(),
      redBadge: (lineOf("public-base-url")?.querySelector(".badge")?.textContent || "").trim(),
      redSettings: (lineOf("public-base-url")?.querySelector(".golive-settings")?.textContent || "").replace(/\s+/g, " ").trim(),
      offBadge: (lineOf("final-submit")?.querySelector(".badge")?.textContent || "").trim(),
      hostileText: (lineOf("session-key")?.querySelector("strong")?.textContent || ""),
      imgs: body.querySelectorAll("img").length,
      areas: Array.from(body.querySelectorAll("[data-golive-area] h3")).map((h) => h.textContent),
      buttons: body.querySelectorAll('button[data-golive-open="destinations"]').length,
    };
  });
  check("the summary leads with the blockers", /^1 blocker\(s\)\. 1 warning\(s\), 1 switched off, 1 OK\./.test(view.summary), view.summary);
  check("a red line reads Blocker, its settings only as set / not set", view.redBadge === "Blocker" && view.redSettings === "PUBLIC_BASE_URL not set", `${view.redBadge} | ${view.redSettings}`);
  check("a deliberately-off switch reads Off", view.offBadge === "Off", view.offBadge);
  check("server text is escaped: a hostile label is text, no element", view.hostileText === "<img src=x onerror=alert(1)>" && view.imgs === 0 && dialogs.length === 0, `${view.hostileText} imgs=${view.imgs} dialogs=${dialogs.length}`);
  check("lines are grouped by area in the fixed order", JSON.stringify(view.areas) === JSON.stringify(["Filing switches", "Client links and email", "Sign-in and secrets", "Database and jobs"]), JSON.stringify(view.areas));
  check("only the destinations line carries a button to its view", view.buttons === 1);

  console.log("\n[W] refresh writes nothing");
  await page.evaluate(() => { (document.getElementById("refreshGoLiveBtn") as HTMLButtonElement).click(); });
  check("Refresh reads the check again", await until(() => counts.goLive === 2), `GETs ${counts.goLive}`);

  console.log("\n[D] destinations");
  await page.waitForSelector('#goLiveBody button[data-golive-open="destinations"]', { state: "visible", timeout: 10000 });
  await page.click('#goLiveBody button[data-golive-open="destinations"]');
  check("it opens Destinations to confirm (GET /api/filing-destinations)", await until(() => counts.queue >= 1), `queue GETs ${counts.queue}`);
  const modals = await page.evaluate(() => ({ goLive: (document.getElementById("goLiveModal") as HTMLElement).hidden, queue: (document.getElementById("destQueueModal") as HTMLElement).hidden }));
  check("…and closes the Go-live check", modals.goLive === true && modals.queue === false, JSON.stringify(modals));
  await page.evaluate(() => { (document.getElementById("closeDestQueueBtn") as HTMLButtonElement).click(); });

  console.log("\n[E] Esc closes it");
  await page.evaluate(() => { (document.getElementById("openGoLiveBtn") as HTMLButtonElement).click(); });
  await page.waitForSelector("#goLiveModal:not([hidden])", { timeout: 5000 }).catch(() => null);
  await page.keyboard.press("Escape");
  check("Esc closes the Go-live check", await until(() => true) && await page.evaluate(() => (document.getElementById("goLiveModal") as HTMLElement).hidden));
  check("opening, refreshing and closing it sent no write", writesAfterOpen.length === 0, JSON.stringify(writesAfterOpen));
  if (pageErrors.length) console.log(`  (page errors from unstubbed panels: ${pageErrors.slice(0, 2).join(" | ").slice(0, 300)})`);
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
