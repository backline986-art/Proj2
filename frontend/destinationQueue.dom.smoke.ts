// =================================================================================================
// "DESTINATIONS TO CONFIRM": A CONFIRM FROM THE QUEUE LANDS EXACTLY AS IT DOES FROM THE TRACK CARD.
//
// Owner, 2026-11-10: every authority needs one named person's Confirm or Verify before automation may
// file there. The queue (GET /api/filing-destinations, opened from the "⋯" menu) lists them all on one
// screen; its Confirm / Edit / Reject must be the track card's, on the job the proposal names: no new
// write path, no bulk confirm.
//
// The whole shipped dashboard.js runs here in real Chromium against a stubbed /api (synthetic data,
// state ZZ, sign-in off). The person's name is typed into the prompt like an operator would.
//   [T] the track card: open the job, click Confirm on the proposed destination → the PUT it sends;
//   [Q] the queue: open "Destinations to confirm", click Confirm on the SAME proposal → its PUT must be
//       byte-identical (same method, same route on the same job, same body) — and the queue re-reads;
//   [V] the view: grouped by client, "check by hand" shows the page link, one Confirm per proposal and
//       no bulk action, the authority with nothing to propose links its job;
//   [R] Reject from the queue posts to the job the proposal names, after the person is named;
//   [N] cancelling the name prompt sends nothing.
//
// Discovered from disk by scripts/run-dom-smokes.ts: `npm run portal:test:dom`.
// Alone: `npx tsx frontend/destinationQueue.dom.smoke.ts`
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

const PID = "p-queue-1";
const OTHER_PID = "p-queue-2";
const PERSON = "Pat Synthetic";
const project = {
  id: PID, clientId: "c1", homeownerName: "Synthetic Owner", projectAddress: "1 Test Way", ahj: "City of Fernhollow", state: "ZZ",
  utility: "", status: "ready_to_stage", stageDetail: "", systemSizeDcKw: 7.2, systemSizeAcKw: 6.5,
  createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", parserSnapshot: {},
};
const detail = { project, projectNotes: [], qcResults: [], corrections: [], submissions: [], documents: [], auditLogs: [], permitStatusChecks: [], reviewItems: [], notes: [] };
const track = {
  type: "combo", label: "Combination permit", category: "permit", channel: "Permit portal not yet identified", channelBasis: "unknown",
  status: "not_started", statusLabel: "Not started", nextAction: "Stage", applicationNumber: "", permitNumber: "", confirmationNumber: "",
  trackingUrl: "", submittedAt: null, lastCheckedAt: null, captureFields: [], outstanding: true, hasRecipe: false,
};
const proposal = {
  id: "fd0123456789abcdef012345", kind: "portal", address: "https://permits.fernhollow-zz.gov/apply",
  sourceUrl: "https://www.fernhollow-zz.gov/building/solar", sourceHost: "www.fernhollow-zz.gov", quote: "Apply for a Permit",
  fetchedAt: "2026-11-10T08:19:28Z", from: "reference", official: true, quoteNamesAddress: false, problems: [] as string[],
};
const authority = { kind: "ahj", name: "City of Fernhollow", state: "ZZ", profileKey: "zz|city of fernhollow" };
// What GET /api/projects/:id/filing-destinations returns for the job (the track card's read).
const cardPayload = { destinations: [{ authority, tracks: ["combo"], status: "proposed", proposals: [proposal], rejected: [], skipped: [] }] };
// What GET /api/filing-destinations returns: the same proposal, naming the job and track that show it.
const queuePayload = {
  clients: [
    { clientId: "c1", clientName: "Queue One Solar", authorities: [
      { authority, tracks: ["combo"], status: "proposed", proposals: [{ ...proposal, act: { projectId: PID, track: "combo" } }], rejected: [], skipped: [],
        jobs: [{ projectId: PID, label: "Synthetic Owner, 1 Test Way", tracks: ["combo"] }], open: { projectId: PID, track: "combo" }, handCheck: [] },
    ] },
    { clientId: "c2", clientName: "Queue Two Solar", authorities: [
      { authority: { kind: "ahj", name: "Town of Alderbank", state: "ZZ", profileKey: "zz|town of alderbank" }, tracks: ["building"], status: "none",
        proposals: [], rejected: [], skipped: [], jobs: [{ projectId: OTHER_PID, label: "Synthetic Owner Two", tracks: ["building"] }],
        open: { projectId: OTHER_PID, track: "building" },
        handCheck: [{ authorityKind: "ahj", state: "ZZ", authority: "Alderbank", pageUrl: "https://www.alderbank-zz.gov/permits/171", happened: "connection reset on an automated read", check: "Whether solar takes one permit or two.", recordedAt: "2026-11-10", source: "synthetic" }] },
      { authority: { kind: "utility", name: "Brightwater Valley Electric", state: "ZZ", profileKey: "zz|brightwater valley electric" }, tracks: ["nem"], status: "proposed",
        proposals: [{ ...proposal, id: "fdutil0000000000000000000", address: "https://brightwater.powerclerk.com/MvcAccount/Login", sourceUrl: "https://www.brightwater-zz.gov/solar/apply", sourceHost: "www.brightwater-zz.gov", quote: "Submit your interconnection application online through PowerClerk", from: "utility_lookup", act: { projectId: OTHER_PID, track: "nem" } }],
        rejected: [], skipped: [], jobs: [{ projectId: OTHER_PID, label: "Synthetic Owner Two", tracks: ["nem"] }], open: { projectId: OTHER_PID, track: "nem" }, handCheck: [] },
    ] },
  ],
  counts: { jobs: 2, authorities: 3, oneClick: 2, editOnly: 0, noProposal: 1, handCheck: 1, alreadyVerified: 0 },
};

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
    if (p === "/api/projects") return json({ projects: [project], total: 1 });
    if (p === `/api/projects/${PID}`) return json(detail);
    if (p === `/api/projects/${PID}/submittal-tracks`) return json({ tracks: [track] });
    if (p === `/api/projects/${PID}/filing-destinations` && method === "GET") { counts.cardGets++; return json(cardPayload); }
    if (/^\/api\/projects\/[^/]+\/filing-destinations(\/reject)?$/.test(p) && method !== "GET") return json({ action: "confirmed", ...cardPayload });
    if (p === "/api/filing-destinations") { counts.queueGets++; return json(queuePayload); }
    if (p === `/api/projects/${PID}/submit-gate`) return json({ decision: "blocked", headline: "stub gate", nextAction: "", checks: [], canPrepareSubmission: false, blockers: [] });
    if (p === "/api/users") return json([]);
    if (p === "/api/clients") return json({ clients: [] });
    return json({});
  });

  console.log("\n[T] the track card's Confirm");
  await page.goto(`http://dash.test/dashboard.html#/project/${PID}`, { waitUntil: "domcontentloaded" });
  const cardBtn = await page.waitForSelector(`#submittalTracks button[data-fd-confirm][data-fd-id="${proposal.id}"]`, { state: "attached", timeout: 20000 }).catch(() => null);
  check("the job's track group shows the proposed destination with Confirm (harness sanity)", Boolean(cardBtn), pageErrors.slice(0, 3).join(" | "));
  if (cardBtn) await cardBtn.evaluate((b: HTMLButtonElement) => b.click());
  await until(() => writes.length >= 1);
  const fromCard = writes.shift();
  check("the track card's Confirm sent one PUT to the job's filing-destinations route", Boolean(fromCard) && fromCard!.method === "PUT" && fromCard!.path === `/api/projects/${PID}/filing-destinations`, JSON.stringify(fromCard));
  check("…naming the person and the exact proposal shown", fromCard?.body.decidedBy === PERSON && fromCard?.body.proposalId === proposal.id && fromCard?.body.address === proposal.address && fromCard?.body.quote === proposal.quote, JSON.stringify(fromCard?.body));

  console.log("\n[Q] the queue's Confirm on the same proposal");
  await page.evaluate(() => { (document.getElementById("openDestQueueBtn") as HTMLButtonElement).click(); });
  const queueBtn = await page.waitForSelector(`#destQueueBody button[data-fd-confirm][data-fd-id="${proposal.id}"]`, { state: "visible", timeout: 15000 }).catch(() => null);
  check("the menu opens Destinations to confirm with the proposal's Confirm", Boolean(queueBtn) && counts.queueGets >= 1, `queue GETs ${counts.queueGets}`);
  const gets0 = counts.queueGets;
  if (queueBtn) await queueBtn.click();
  await until(() => writes.length >= 1);
  const fromQueue = writes.shift();
  check("the queue's Confirm is byte-identical to the track card's: same method, same route on the same job, same body",
    JSON.stringify(fromQueue) === JSON.stringify(fromCard), `card ${JSON.stringify(fromCard)}\n         queue ${JSON.stringify(fromQueue)}`);
  check("after it, the queue re-reads (the confirmed authority drops out on the server's next answer)", await until(() => counts.queueGets > gets0), `queue GETs ${gets0} -> ${counts.queueGets}`);
  const toast = await page.locator("#toastContainer").textContent().catch(() => "");
  check("the person is told it was recorded under their name and nothing was filed or sent", /Confirmed under your name[\s\S]*Nothing was filed or sent/.test(String(toast)), String(toast));

  console.log("\n[V] the view");
  const view = await page.evaluate(() => {
    const body = document.getElementById("destQueueBody")!;
    return {
      clients: Array.from(body.querySelectorAll("section[data-fd-client] h3")).map((h) => (h.textContent || "").replace(/\s+/g, " ").trim()),
      confirms: body.querySelectorAll("button[data-fd-confirm]").length,
      buttons: Array.from(body.querySelectorAll("button")).map((b) => (b.textContent || "").trim()),
      hand: Array.from(body.querySelectorAll("[data-fd-handcheck] a")).map((a) => (a as HTMLAnchorElement).href),
      none: (body.querySelector("[data-fd-none]")?.innerHTML || ""),
      utilProject: (body.querySelector('button[data-fd-confirm][data-fd-id="fdutil0000000000000000000"]') as HTMLElement | null)?.dataset.fdProject || "",
      summary: (body.querySelector("[data-fd-queue-summary]")?.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
  check("grouped by client", view.clients.length === 2 && view.clients[0].startsWith("Queue One Solar") && view.clients[1].startsWith("Queue Two Solar"), JSON.stringify(view.clients));
  check("one Confirm per proposal, and no bulk action", view.confirms === 2 && !view.buttons.some((t) => /all/i.test(t)), JSON.stringify(view.buttons));
  check("'check by hand' shows the page link", view.hand.length === 1 && view.hand[0] === "https://www.alderbank-zz.gov/permits/171", JSON.stringify(view.hand));
  check("an authority with nothing to propose links the job to state it on", view.none.includes(`href="#/project/${OTHER_PID}"`), view.none);
  check("each proposal's buttons name the job that shows it", view.utilProject === OTHER_PID, view.utilProject);
  check("the summary counts the authorities waiting on a person", /3 authorities wait on a person: 2 one-click, 0 need Edit, 1 with nothing to propose, 1 with pages to check by hand/.test(view.summary), view.summary);

  console.log("\n[R] Reject from the queue");
  await page.evaluate(() => { (document.querySelector('#destQueueBody button[data-fd-reject][data-fd-id="fdutil0000000000000000000"]') as HTMLButtonElement).click(); });
  await until(() => writes.length >= 1);
  const rejected = writes.shift();
  check("Reject posts to the job the proposal names, with the person and the proposal", Boolean(rejected) && rejected!.method === "POST" && rejected!.path === `/api/projects/${OTHER_PID}/filing-destinations/reject`
    && rejected!.body.track === "nem" && rejected!.body.proposalId === "fdutil0000000000000000000" && rejected!.body.decidedBy === PERSON, JSON.stringify(rejected));

  console.log("\n[N] cancelling the name sends nothing");
  await page.waitForSelector(`#destQueueBody button[data-fd-confirm][data-fd-id="${proposal.id}"]`, { state: "visible", timeout: 10000 }).catch(() => null);
  cancelNext = true;
  await page.evaluate((id: string) => { (document.querySelector(`#destQueueBody button[data-fd-confirm][data-fd-id="${id}"]`) as HTMLButtonElement).click(); }, proposal.id);
  await sleep(800);
  check("no request when the person cancels", writes.length === 0, JSON.stringify(writes));
  if (pageErrors.length) console.log(`  (page errors from unstubbed panels, isolated by safeRender: ${pageErrors.slice(0, 2).join(" | ").slice(0, 300)})`);
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
