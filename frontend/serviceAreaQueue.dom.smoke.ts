// =================================================================================================
// "DESTINATIONS TO CONFIRM" FOR A CLIENT'S SERVICE AREA: AN AUTHORITY NO JOB NAMES YET.
//
// The whole shipped dashboard.js runs here in real Chromium against a stubbed /api (synthetic data,
// state ZZ, sign-in off). The queue lists one service-area authority (no job), whose proposal carries
// its client, area entry and authority (areaAct). The person's name is typed into the prompt.
//   [Q] Confirm sends ONE PUT to that client's twin route, /api/clients/:id/service-area/filing-destinations,
//       with exactly the track card's body (track, proposal, kind, address, page, words, the person) plus
//       the area entry and the authority shown — and the queue re-reads;
//   [V] the view: the "Service area" badge, the entry it came from, one Confirm per proposal, no bulk;
//   [R] Reject posts to the twin's /reject with the person, the proposal, the entry and the authority;
//   [N] cancelling the name prompt sends nothing.
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/serviceAreaQueue.dom.smoke.ts`
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

const PERSON = "Pat Synthetic";
const proposal = {
  id: "fdarea00000000000000000a", kind: "portal", address: "https://permits.fernhollow-zz.gov/apply",
  sourceUrl: "https://www.fernhollow-zz.gov/building/solar", sourceHost: "www.fernhollow-zz.gov", quote: "Apply for a Permit",
  fetchedAt: "2026-11-10T08:19:28Z", from: "reference", official: true, quoteNamesAddress: false, problems: [] as string[],
};
const authority = { kind: "ahj", name: "City of Fernhollow", state: "ZZ", profileKey: "zz|city of fernhollow" };
const areaAct = { clientId: "c-area-9", entryKey: "city|ZZ|fernhollow", authorityKey: "ahj|zz|city of fernhollow", track: "combo" };
const queuePayload = {
  clients: [
    { clientId: "c-area-9", clientName: "Area Queue Solar", authorities: [
      { authority, tracks: ["combo"], status: "proposed", proposals: [{ ...proposal, areaAct }], rejected: [], skipped: [],
        jobs: [], open: null, handCheck: [], serviceArea: { entry: { kind: "city", state: "ZZ", name: "Fernhollow" }, entryKey: areaAct.entryKey, matchedFrom: "reference" } },
    ] },
  ],
  counts: { jobs: 0, authorities: 1, oneClick: 1, editOnly: 0, noProposal: 0, handCheck: 0, alreadyVerified: 0, serviceArea: 1 },
};
// The track card's Confirm body for the same proposal (filing-destination.js confirmBody) and the person.
const cardBody = { track: "combo", proposalId: proposal.id, kind: proposal.kind, address: proposal.address, sourceUrl: proposal.sourceUrl, quote: proposal.quote, decidedBy: PERSON };

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml" };
type Write = { method: string; path: string; body: Record<string, unknown> };

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  const writes: Write[] = [];
  const counts = { queueGets: 0, cardGets: 0 };
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(String(e && e.message || e)));
  // The operator types their name into the prompt (sign-in off) and accepts every confirm, unless a
  // scenario says to cancel.
  let cancelNext = false;
  page.on("dialog", async (d: { type(): string; accept(v?: string): Promise<void>; dismiss(): Promise<void> }) => {
    if (cancelNext) { cancelNext = false; return d.dismiss(); }
    if (d.type() === "prompt") return d.accept(PERSON);
    return d.accept();
  });
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
    const method = req.method();
    // Only the destination decisions are recorded: the project page also POSTs its own panels.
    if (method !== "GET" && /\/filing-destinations(\/reject)?$/.test(p)) {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch { body = {}; }
      writes.push({ method, path: p, body });
    }
    if (p === "/health") return json({ ok: true });
    if (p === "/api/events") return route.abort();
    if (p === "/api/auth/me") return json({ enabled: false, user: null });
    if (p === "/api/projects") return json({ projects: [], total: 0 });
    if (/^\/api\/clients\/[^/]+\/service-area\/filing-destinations(\/reject)?$/.test(p) && method !== "GET") return json({ action: "confirmed" });
    if (p === "/api/filing-destinations") { counts.queueGets++; return json(queuePayload); }
    if (p === "/api/users") return json([]);
    if (p === "/api/clients") return json({ clients: [] });
    return json({});
  });

  await page.goto(`http://dash.test/dashboard.html#/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#openDestQueueBtn", { state: "attached", timeout: 20000 });

  console.log("\n[Q] Confirm on a service-area authority");
  await page.evaluate(() => { (document.getElementById("openDestQueueBtn") as HTMLButtonElement).click(); });
  const queueBtn = await page.waitForSelector(`#destQueueBody button[data-fd-confirm][data-fd-id="${proposal.id}"]`, { state: "visible", timeout: 15000 }).catch(() => null);
  check("the queue shows the service-area proposal with Confirm", Boolean(queueBtn) && counts.queueGets >= 1, pageErrors.slice(0, 3).join(" | "));
  const gets0 = counts.queueGets;
  if (queueBtn) await queueBtn.click();
  await until(() => writes.length >= 1);
  const sent = writes.shift();
  check("one PUT to the client's twin route", Boolean(sent) && sent!.method === "PUT" && sent!.path === "/api/clients/c-area-9/service-area/filing-destinations", JSON.stringify(sent));
  const { areaEntry, authorityKey, ...rest } = (sent?.body ?? {}) as Record<string, unknown>;
  check("…with exactly the track card's body plus the entry and the authority shown", JSON.stringify(rest) === JSON.stringify(cardBody) && areaEntry === areaAct.entryKey && authorityKey === areaAct.authorityKey, JSON.stringify(sent?.body));
  check("after it, the queue re-reads", await until(() => counts.queueGets > gets0), `queue GETs ${gets0} -> ${counts.queueGets}`);
  const toast = await page.locator("#toastContainer").textContent().catch(() => "");
  check("the person is told it was recorded under their name and nothing was filed or sent", /Confirmed under your name[\s\S]*Nothing was filed or sent/.test(String(toast)), String(toast));

  console.log("\n[V] the view");
  const view = await page.evaluate(() => {
    const body = document.getElementById("destQueueBody")!;
    return {
      badge: body.querySelectorAll("[data-fd-service-area]").length,
      head: (body.querySelector(".fd-head")?.textContent || "").replace(/\s+/g, " ").trim(),
      confirms: body.querySelectorAll("button[data-fd-confirm]").length,
      buttons: Array.from(body.querySelectorAll("button")).map((b) => (b.textContent || "").trim()),
      summary: (body.querySelector("[data-fd-queue-summary]")?.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
  check("the Service area badge and the entry it came from", view.badge === 1 && /no open job yet · from the service area entry "Fernhollow, ZZ"/.test(view.head), JSON.stringify(view));
  check("one Confirm per proposal, and no bulk action", view.confirms === 1 && !view.buttons.some((t) => /all/i.test(t)), JSON.stringify(view.buttons));
  check("the summary says it waits only in a service area", /1 only in a service area, with no job yet/.test(view.summary), view.summary);

  console.log("\n[R] Reject from the queue");
  await page.evaluate((id: string) => { (document.querySelector(`#destQueueBody button[data-fd-reject][data-fd-id="${id}"]`) as HTMLButtonElement).click(); }, proposal.id);
  await until(() => writes.length >= 1);
  const rejected = writes.shift();
  check("Reject posts to the twin's /reject with the person, the proposal, the entry and the authority", Boolean(rejected) && rejected!.method === "POST" && rejected!.path === "/api/clients/c-area-9/service-area/filing-destinations/reject"
    && rejected!.body.track === "combo" && rejected!.body.proposalId === proposal.id && rejected!.body.decidedBy === PERSON && rejected!.body.areaEntry === areaAct.entryKey && rejected!.body.authorityKey === areaAct.authorityKey, JSON.stringify(rejected));

  console.log("\n[N] cancelling the name sends nothing");
  await page.waitForSelector(`#destQueueBody button[data-fd-confirm][data-fd-id="${proposal.id}"]`, { state: "visible", timeout: 10000 }).catch(() => null);
  cancelNext = true;
  await page.evaluate((id: string) => { (document.querySelector(`#destQueueBody button[data-fd-confirm][data-fd-id="${id}"]`) as HTMLButtonElement).click(); }, proposal.id);
  await sleep(800);
  check("no request when the person cancels", writes.length === 0, JSON.stringify(writes));
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
