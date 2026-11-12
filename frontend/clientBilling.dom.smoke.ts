// CLIENT BILLING (#700) — real Chromium, the dashboard's own markup, stubbed API.
//
//   MUST PASS — the selected client's invoices list with the right actions per status (a paid or
//               void invoice offers no Email / Void); "Show draft statement" draws the statement's
//               lines by kind, the amount due, the exclusions and the unagreed-login warning, and
//               enables "Create invoice"; "Create invoice" POSTs the month and says what it made.
//   MUST PASS — every server string is ESCAPED: a homeowner name carrying markup renders as text,
//               never as an element (CLAUDE.md: frontend esc() everything).
//   MUST PASS — at 390px the billing block does not scroll the page sideways and no button wraps
//               mid-word.
//   MUST PASS (#701) — with QuickBooks connected, an open invoice not yet in QuickBooks offers "Send to
//               QuickBooks" and a draft offers "Add onboarding line"; an invoice already in QuickBooks
//               shows its QuickBooks number and status (escaped) and offers neither. "Send to
//               QuickBooks" POSTs the typed person's name. The QuickBooks block shows the chosen Items
//               and never a token.
//   MUST PASS (#187) — the Prices block shows the org's price per permit filing and per NEM application
//               (an unset one flagged NOT SET); "Save prices" PUTs both with the named person. A filing
//               line on the statement offers "Don't bill", which POSTs a reason and the named person
//               for that charge only.
//
// Hermetic: a throwaway static server over frontend/, stubbed /api/clients/... with FAKE data,
// everything else 404. No backend, no database, nothing emailed.
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/clientBilling.dom.smoke.ts`

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const CLIENT = { id: "client-fake-1", companyName: "Fake Solar Co (TEST)", billingMode: "per_submission", portalIdentities: [], stateLicenses: [] };
const HOSTILE = `Test Owner <img src=x id="injected" onerror="window.__pwned=1">`;
const line = (over: Record<string, unknown>) => ({
  lineKey: "row-1:reimbursement", projectId: "p-1", paymentId: "row-1", projectLabel: HOSTILE, track: "permit",
  kind: "reimbursement", role: "charge", basis: "recorded", provisional: false, alreadyPaid: false, amountUsd: 360,
  description: "Building/electrical permit fee — advanced by us, re-billed at cost", paymentReference: "", eventAt: "2026-11-03T10:00:00.000Z",
  carriedForward: false, composition: [], reconciliation: "", adjusts: null, ...over,
});
const STATEMENT = {
  clientId: CLIENT.id, clientName: CLIENT.companyName, billTo: "ap@example.invalid", billToSource: "billing_contact", billingMode: "per_submission",
  periodStart: "2026-11-01", periodEnd: "2026-12-01",
  lines: [
    line({}),
    line({ lineKey: "row-1:service", kind: "service", basis: "service", amountUsd: 175, alreadyPaid: true, description: "Submission service fee (paid at the gate)" }),
    line({ lineKey: "row-1:received", kind: "received", role: "received", basis: "received", amountUsd: 175, alreadyPaid: true, description: "Service fee paid at the per-submission gate" }),
    line({ lineKey: "filing:chg-1:service", paymentId: "chg-1", kind: "service", basis: "price_list", amountUsd: 99, description: "Filing service fee — building permit filing filed 2026-11-04", reconciliation: "Price saved when it was filed: the price list's price per permit filing." }),
    line({ lineKey: "row-2:reimbursement:adj:x", projectLabel: "Second Owner", role: "adjustment", amountUsd: 14.5, description: "true-up", adjusts: { billedUsd: 200, invoiceNumbers: ["INV-2026-0001"] } }),
  ],
  excluded: [{ track: "permit", projectId: "p-3", projectLabel: "Third Owner", reason: "No fee responsibility is on file <b>bold</b>", resolution: "Record it.", amountSeenUsd: 99 }],
  loginsWithoutFeeAgreement: ["permits.example.invalid"],
  notes: [],
  reimbursementTotalUsd: 374.5, serviceTotalUsd: 0, receivedTotalUsd: 175, dueTotalUsd: 374.5,
  generatedAt: "2026-11-10T00:00:00.000Z",
};
const INVOICES = [
  { id: "inv-a", number: "INV-2026-0002", clientId: CLIENT.id, periodStart: "2026-10-01", periodEnd: "2026-11-01", status: "draft", dueTotalUsd: 200, dueAt: "", paidAt: "", paidReference: "", voidReason: "", lines: [] },
  { id: "inv-q", number: "INV-2026-0003", clientId: CLIENT.id, periodStart: "2026-08-01", periodEnd: "2026-09-01", status: "sent", dueTotalUsd: 80, dueAt: "2026-09-16", paidAt: "", paidReference: "", voidReason: "", lines: [],
    externalRef: "501", qbPushedBy: "Test Person", qbStatus: "partly paid <b>x</b>", qbBalanceUsd: 40 },
  { id: "inv-b", number: "INV-2026-0001", clientId: CLIENT.id, periodStart: "2026-09-01", periodEnd: "2026-10-01", status: "paid", dueTotalUsd: 120, dueAt: "2026-10-31", paidAt: "2026-10-20T00:00:00Z", paidReference: "ach-1", voidReason: "", lines: [] },
];
const QB_STATUS = {
  syncOn: true, appConfigured: true, connected: true, realmId: "9130-TEST", connectedBy: "Test Person", connectedAt: "2026-11-10T00:00:00Z",
  lastStatusSyncAt: "", lastError: "", settingsBy: "Test Person",
  items: { service: { id: "11", name: "Filing service fee" }, passthrough: { id: "12", name: "Permit & portal fee (pass-through)" }, onboarding: { id: "", name: "" } },
};
const PRICES = {
  orgId: "org-default", envDefaultUsd: null,
  prices: { permit: { track: "permit", priceUsd: 99, setBy: "Test <b>Admin</b>", setAt: "2026-11-12T00:00:00Z" }, nem: { track: "nem", priceUsd: null, setBy: "", setAt: "" } },
};
const posted: string[] = [];
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };

const startServer = async (): Promise<{ base: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const json = (body: unknown, status = 200): void => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
    if (url.pathname === "/health") { json({ ok: true }); return; }
    if (url.pathname.startsWith("/api/")) {
      const p = url.pathname;
      if (p === "/api/projects") return json({ projects: [], total: 0 });
      if (p === "/api/clients") return json({ clients: [CLIENT] });
      if (/^\/api\/users/.test(p)) return json({ users: [] });
      if (/^\/api\/clients\/[^/]+\/portal-credentials$/.test(p)) return json({ credentials: [] });
      if (p === "/api/quickbooks/status") return json({ quickbooks: QB_STATUS });
      if (p === "/api/billing/prices") {
        if (req.method === "PUT") {
          let body = "";
          req.on("data", (c) => { body += c; });
          req.on("end", () => { posted.push(`PUT prices ${body}`); json({ prices: { ...PRICES, prices: { ...PRICES.prices, nem: { track: "nem", priceUsd: 79, setBy: "Test Person", setAt: "2026-11-12T00:00:00Z" } } } }); });
          return;
        }
        return json({ prices: PRICES });
      }
      if (/^\/api\/clients\/[^/]+\/filing-charges\/[^/]+\/waive$/.test(p) && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { posted.push(`POST waive ${p.split("/")[5]} ${body}`); json({ charge: { id: "chg-1", waivedBy: "Test Person" } }); });
        return;
      }
      if (/^\/api\/clients\/[^/]+\/invoices\/[^/]+\/quickbooks$/.test(p) && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { posted.push(`POST quickbooks ${p.split("/")[5]} ${body}`); json({ created: true, adopted: false, externalRef: "502", invoice: { ...INVOICES[0], externalRef: "502" } }); });
        return;
      }
      if (/^\/api\/clients\/[^/]+\/billing\/statement$/.test(p)) {
        posted.push(`GET statement ${url.searchParams.get("month")}`);
        return json({ statement: STATEMENT });
      }
      if (/^\/api\/clients\/[^/]+\/invoices$/.test(p)) {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => { body += c; });
          req.on("end", () => { posted.push(`POST invoices ${body}`); json({ invoice: { ...INVOICES[0], id: "inv-new", number: "INV-2026-0003" } }, 201); });
          return;
        }
        return json({ invoices: INVOICES });
      }
      json({ error: "not stubbed" }, 404);
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
    for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
      const tag = `${vp.w}px`;
      console.log(`\nVIEWPORT ${vp.w}x${vp.h}`);
      posted.length = 0;
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      await ctx.addInitScript("globalThis.__name = (f) => f;");
      const page = await ctx.newPage();
      page.on("dialog", (d: { type(): string; accept(v?: string): Promise<void> }) => { void (d.type() === "prompt" ? d.accept("Test Person") : d.accept()); });
      await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(`${base}/#/dashboard`, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(400);
      await page.evaluate(() => (document.getElementById("openClientsBtn") as HTMLButtonElement).click());
      await page.waitForSelector("[data-client-id]", { timeout: 15000 });
      await page.evaluate(() => (document.querySelector("[data-client-id]") as HTMLButtonElement).click());
      await page.waitForSelector("#billingInvoices [data-inv-action]", { timeout: 15000 });

      const list = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#billingInvoices .cred-row")];
        return rows.map((r) => ({ text: (r.textContent || "").replace(/\s+/g, " ").trim(), actions: [...r.querySelectorAll("[data-inv-action]")].map((b) => b.getAttribute("data-inv-action")) }));
      });
      check(list.length === 3, `${tag}: every invoice is listed`, JSON.stringify(list));
      check(list[0]?.actions.join(",") === "print,send,mark-sent,add-line,quickbooks,mark-paid,void", `${tag}: a DRAFT offers print, email, mark sent, add onboarding line, send to QuickBooks, mark paid, void`, JSON.stringify(list[0]));
      check(list[1]?.actions.join(",") === "print,send,mark-paid,void" && /QuickBooks #501: partly paid <b>x<\/b>/.test(list[1]?.text || ""),
        `${tag}: an invoice already in QuickBooks shows its number and status as text and is not offered again`, JSON.stringify(list[1]));
      check(list[2]?.actions.join(",") === "print" && /paid/.test(list[2]?.text || ""), `${tag}: a PAID invoice offers print only`, JSON.stringify(list[2]));
      const qb = await page.evaluate(() => (document.getElementById("quickbooksBlock")?.textContent || "").replace(/\s+/g, " "));
      check(/9130-TEST/.test(qb) && /Pass-through fees → Permit & portal fee \(pass-through\)/.test(qb) && /NOT CHOSEN/.test(qb) && !/token/i.test(qb),
        `${tag}: the QuickBooks block shows the company and the chosen Items, flags the unchosen one, and no token`, qb);
      check(await page.evaluate(() => !document.querySelector("#billingInvoices b")), `${tag}: a QuickBooks status carrying markup renders as text`);
      await page.evaluate(() => (document.querySelector('[data-inv-action="quickbooks"]') as HTMLButtonElement).click());
      await page.waitForFunction(() => /In QuickBooks as invoice #502/.test(document.getElementById("billingStatus")?.textContent || ""), null, { timeout: 15000 });
      check(posted.some((x) => x === 'POST quickbooks inv-a {"decidedBy":"Test Person"}'), `${tag}: Send to QuickBooks POSTs the named person, for that invoice only`, posted.join(" | "));

      check(await page.evaluate(() => (document.getElementById("billingCreateBtn") as HTMLButtonElement).disabled), `${tag}: Create invoice is disabled before a statement is shown`);
      await page.evaluate(() => (document.getElementById("billingPreviewBtn") as HTMLButtonElement).click());
      await page.waitForSelector("#billingStatement .billing-statement", { timeout: 15000 });
      const st = await page.evaluate(() => {
        const box = document.getElementById("billingStatement")!;
        return {
          text: (box.textContent || "").replace(/\s+/g, " "),
          injected: Boolean(document.getElementById("injected")) || Boolean((window as unknown as { __pwned?: number }).__pwned) || Boolean(box.querySelector("b")),
          kinds: box.querySelectorAll(".billing-kind").length,
          createEnabled: !(document.getElementById("billingCreateBtn") as HTMLButtonElement).disabled,
        };
      });
      check(!st.injected && st.text.includes("<img src=x"), `${tag}: a homeowner name carrying markup renders as TEXT, never an element`, st.text.slice(0, 160));
      check(st.kinds === 3, `${tag}: lines are grouped by kind (fees at cost, service, received)`, String(st.kinds));
      check(/Amount due\s*\$374\.50/.test(st.text), `${tag}: the amount due is shown`, st.text);
      check(/true-up/.test(st.text) && /already paid/.test(st.text), `${tag}: an adjustment and an already-paid line say so`);
      check(/1 not on this statement, and why/.test(st.text), `${tag}: the exclusions are counted`);
      check(/1 portal login has no fee agreement/.test(st.text), `${tag}: an unagreed login is warned about`);
      check(st.createEnabled, `${tag}: Create invoice is enabled once a statement with lines is shown`);
      check(posted.some((x) => /^GET statement \d{4}-\d{2}$/.test(x)), `${tag}: the statement is asked for by month`, posted.join(" | "));

      // #187: the price list and "Don't bill" on a filing line.
      const pr = await page.evaluate(() => ({
        text: (document.getElementById("servicePricesBlock")?.textContent || "").replace(/\s+/g, " "),
        permit: (document.getElementById("pricePermitUsd") as HTMLInputElement | null)?.value,
        nem: (document.getElementById("priceNemUsd") as HTMLInputElement | null)?.value,
        markup: Boolean(document.querySelector("#servicePricesBlock b")),
      }));
      check(pr.permit === "99" && pr.nem === "" && /NEM: NOT SET/.test(pr.text) && /Test <b>Admin<\/b>/.test(pr.text) && !pr.markup,
        `${tag}: the Prices block shows the permit price, flags the unset NEM price, and renders a name with markup as text`, JSON.stringify(pr));
      await page.evaluate(() => { (document.getElementById("priceNemUsd") as HTMLInputElement).value = "79"; (document.getElementById("savePricesBtn") as HTMLButtonElement).click(); });
      await page.waitForFunction(() => /Prices saved/.test(document.getElementById("billingStatus")?.textContent || ""), null, { timeout: 15000 });
      check(posted.some((x) => x === 'PUT prices {"permitUsd":"99","nemUsd":"79","decidedBy":"Test Person"}'), `${tag}: Save prices PUTs both prices with the named person`, posted.join(" | "));
      const waiveBtns = await page.evaluate(() => [...document.querySelectorAll("#billingStatement [data-waive-charge]")].map((b) => b.getAttribute("data-waive-charge")));
      check(waiveBtns.join(",") === "chg-1", `${tag}: only the filing line offers "Don't bill"`, JSON.stringify(waiveBtns));
      await page.evaluate(() => (document.querySelector('#billingStatement [data-waive-charge="chg-1"]') as HTMLButtonElement).click());
      await page.waitForFunction(() => /will not be billed/.test(document.getElementById("billingStatus")?.textContent || ""), null, { timeout: 15000 });
      check(posted.some((x) => x === 'POST waive chg-1 {"reason":"Test Person","decidedBy":"Test Person"}'), `${tag}: Don't bill POSTs a reason and the named person for that charge`, posted.join(" | "));

      await page.evaluate(() => (document.getElementById("billingCreateBtn") as HTMLButtonElement).click());
      await page.waitForFunction(() => /Created INV-2026-0003/.test(document.getElementById("billingStatus")?.textContent || ""), null, { timeout: 15000 });
      check(posted.some((x) => /^POST invoices \{"month":"\d{4}-\d{2}"\}$/.test(x)), `${tag}: Create invoice POSTs the month`, posted.join(" | "));

      const g = await page.evaluate(() => {
        const block = document.getElementById("clientBillingBlock")!;
        const rect = (el: Element) => el.getBoundingClientRect();
        const wrapped: string[] = [];
        block.querySelectorAll("button").forEach((btn) => {
          if (rect(btn).width === 0) return;
          const label = btn.querySelector("span") || btn;
          const lh = parseFloat(getComputedStyle(btn).lineHeight) || 20;
          if (rect(label).height > lh * 1.6) wrapped.push((btn.id || btn.textContent || "").trim().slice(0, 40));
        });
        return { wrapped, hScroll: document.documentElement.scrollWidth > innerWidth };
      });
      check(g.wrapped.length === 0, `${tag}: no billing button wraps mid-word`, g.wrapped.join(","));
      check(!g.hScroll, `${tag}: no horizontal page scroll`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await close();
  }
  console.log(failures.length ? `\nCLIENT BILLING: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nCLIENT BILLING: all checks passed.");
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
