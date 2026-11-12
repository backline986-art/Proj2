// THE FEE AT THE STOP, IN A REAL BROWSER (#576 acceptance items 1 and 5).
//
// Every fee_payment stop now READS what the portal asks (the shared fee reader) and takes a full-page
// screenshot with the secrets and card fields MASKED — read only: nothing new is clicked, the
// backstop's payment rules are untouched. Two local replicas on 127.0.0.1 (never a real portal), the
// real stage path (stageWithRecipe → RecipeAdapter, its own Chromium, the network backstop):
//
//   PowerClerk-like  pcFeePage: the approved Submit lands on an "Application Fees" page (a fee table,
//                    "Total Due: $150.00", a card-number box, Pay Now) -> paused fee_payment, the click
//                    reported, the amount READ ($150.00, its line), a masked shot on disk, the page's
//                    own link carried as the draft reference, 0 payment POSTs.
//                    pcUnread: the fee page prints no amount -> paused fee_payment, the amount UNREAD
//                    (read:false, totalUsd null — never $0).
//   Accela-like      acaPayToFile: the flagged submit is "Submit & Pay" on a review page whose Fees
//                    block prints two lines and "Total Fees: $337.50" -> paused fee_payment, NOTHING
//                    clicked, 0 POSTs, the amount read ($337.50, two lines).
//                    acaFeeLater: "Fees will be invoiced later." on the confirm (a mode name never
//                    says "invoice": isPayRequestUrl would abort its own submit URL) -> UNCHANGED: files once,
//                    the record captured, not paused, no fee stop.
//   MASK             maskedFeeShot on a fee page: the screenshot's mask covers the card-number box, a
//                    password box and the element printing the project's account number — and leaves
//                    no marker attribute on the page.
//
// Kill: make feeStopError return a bare FinalSubmitStop (no readFeeStop) -> the "amount read" and
// "shot" checks fail; drop the payment/secret tagging in tagSecrets -> the MASK checks fail.
//
//   npx tsx portal-bot/src/adapters/feeStop.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import { maskedFeeShot } from "../feeStop";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const ACCOUNT = "1234567890"; // synthetic
const RECORD = "BLD-26-00777";
const requests: Array<{ mode: string; method: string; path: string }> = [];
// The signed-in signal the replay's login check reads (the same nav the approved-submit fixture uses).
const NAV = `<nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${NAV}${body}</body></html>`;
const COMPLETION = page("Application Received", `<h1>Application Received</h1><p>Thank you. Your application has been submitted.</p><p>Record Number: ${RECORD}</p>`);
const PC_FEES = (withAmount: boolean): string => page("Application Fees", `<h1>Application Fees</h1>
  ${withAmount
    ? `<table><tr><td>Interconnection Application Fee</td><td>$150.00</td></tr><tr><td>Total Due</td><td>$150.00</td></tr></table>`
    : `<p>Fee summary for this application.</p>`}
  <p id="acct">Service account: ${ACCOUNT}</p>
  <form method="post" action="/m/pc/payment/charge"><label for="cc">Card Number</label><input id="cc" name="cardnumber" autocomplete="cc-number">
  <button type="submit" id="payNow">Pay Now</button></form>`);

const reviewBody = (mode: string): string => {
  if (mode === "acaPayToFile") {
    return `<h1>Step 4 : Review</h1><p>Please review your application before submitting.</p>
      <h2>Fees</h2><dl><dt>Electrical Permit Fee</dt><dd>$250.00</dd><dt>Plan Review Fee</dt><dd>$87.50</dd><dt>Total Fees</dt><dd>$337.50</dd></dl>
      <form method="post" action="/m/${mode}/apply/submit"><button type="submit" id="btnPay">Submit &amp; Pay</button></form>`;
  }
  if (mode === "acaFeeLater") {
    return `<h1>Step 4 : Review</h1><p>Please review your application before submitting.</p>
      <form method="post" action="/m/${mode}/apply/submit"><button type="submit" id="btnSubmit" onclick="return confirm('Submit application? Fees will be invoiced later.')">Submit Application</button></form>`;
  }
  // PowerClerk-like review step.
  return `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
    <dl><dt>Customer</dt><dd>Desmond Yarrowby</dd><dt>System</dt><dd>7.2 kW roof-mounted PV</dd></dl>
    <form method="post" action="/m/${mode}/apply/submit"><button type="submit" id="btnSubmit">Submit</button></form>`;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") requests.push({ mode, method: String(req.method), path: url.pathname });
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method === "POST" && rest === "apply/submit") {
    if (mode === "pcFeePage") { send(PC_FEES(true)); return; }
    if (mode === "pcUnread") { send(PC_FEES(false)); return; }
    send(COMPLETION);
    return;
  }
  if (rest === "fees") { send(PC_FEES(true).replace("</form>", `<label for="pw">Password</label><input id="pw" type="password" value="hunter22"></form>`)); return; }
  if (rest === "review") { send(page("Review and Submit", reviewBody(mode))); return; }
  send(page("Portal", "<h1>Home</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeFor = (mode: string, css: string, note: string): PortalRecipe => ({
  id: `fee-stop-${mode}`, scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/m/${mode}/review`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/m/${mode}/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    { action: "click", selector: { css }, note, isFinalSubmit: true } as RecipeStep,
  ],
} as PortalRecipe);

let seq = 0;
async function stage(mode: string, css = "#btnSubmit", note = "final submit: Submit") {
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  const before = requests.length;
  try {
    const runId = `run-${mode}-${++seq}`;
    const r = await stageWithRecipe(recipeFor(mode, css, note), { id: `p-${mode}` } as ProjectRecord, { accountNumber: ACCOUNT }, {}, [], {
      autoSubmit: true, runApproval: { approver: "A. Operator", runId }, runId, headless: true,
    });
    await new Promise((res) => setTimeout(res, 300));
    return { r, posts: requests.slice(before) };
  } finally {
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
}
type FeeStop = { read?: boolean; totalUsd?: number | null; lines?: Array<{ label: string; amountUsd: number }>; shotPath?: string; where?: string; unreadReason?: string } | undefined;
const brief = (o: { r: Record<string, unknown>; posts: unknown[] }): string =>
  `msg=${JSON.stringify((o.r.steps as Array<{message?: string}> | undefined)?.map((s) => s?.message) ?? o.r.message).slice(0, 900)} posts=${JSON.stringify(o.posts)} clicked=${String(o.r.finalSubmitClicked)} pause=${String(o.r.pauseReason)} feeStop=${JSON.stringify(o.r.feeStop ?? null).slice(0, 300)}`;
const shotOk = (f: FeeStop): boolean => !!f?.shotPath && fs.existsSync(f.shotPath) && fs.statSync(f.shotPath).size > 1000;

console.log("\n1. PowerClerk-like: a fee page AFTER the approved Submit");
{
  const o = await stage("pcFeePage");
  const f = o.r.feeStop as FeeStop;
  check("pcFeePage: paused fee_payment, the click reported, 0 payment POSTs", o.r.pauseReason === "fee_payment" && o.r.finalSubmitClicked === true
    && o.posts.filter((p) => /payment|charge/.test(p.path)).length === 0, brief(o));
  check("pcFeePage: the amount is READ off the page — $150.00, its fee line", f?.read === true && f.totalUsd === 150
    && (f.lines ?? []).some((l) => /Interconnection Application Fee/.test(l.label) && l.amountUsd === 150), brief(o));
  check("pcFeePage: a fee_page stop, with its screenshot on disk and as the run's outcome shot", f?.where === "fee_page" && shotOk(f) && o.r.outcomeShotPath === f?.shotPath, brief(o));
  const ref = o.r.draftReference as { link?: string } | undefined;
  check("pcFeePage: the page's own link is carried as the draft reference (the way back)", !!ref?.link && ref.link.startsWith(base), JSON.stringify(ref ?? null));
  check("pcFeePage: the fee lines carry no account number", !JSON.stringify(f ?? {}).includes(ACCOUNT), JSON.stringify(f ?? {}));
}
{
  const o = await stage("pcUnread");
  const f = o.r.feeStop as FeeStop;
  check("pcUnread: paused fee_payment; the amount UNREAD (read false, totalUsd null — never $0), the reason said",
    o.r.pauseReason === "fee_payment" && f?.read === false && f.totalUsd === null && !!f.unreadReason, brief(o));
}

console.log("\n2. Accela-like: a pay-to-file 'Submit & Pay', and an invoiced-later confirm");
{
  const o = await stage("acaPayToFile", "#btnPay", "final submit: Submit & Pay");
  const f = o.r.feeStop as FeeStop;
  check("acaPayToFile: 0 POSTs, NOTHING clicked, paused fee_payment", o.posts.length === 0 && o.r.finalSubmitClicked === false && o.r.pauseReason === "fee_payment", brief(o));
  check("acaPayToFile: the amount is read — the printed total $337.50, two fee lines", f?.read === true && f.totalUsd === 337.5 && (f.lines ?? []).length === 2 && f.where === "pay_to_file", brief(o));
  check("acaPayToFile: a screenshot was taken", shotOk(f), brief(o));
}
{
  const o = await stage("acaFeeLater");
  check("acaFeeLater: UNCHANGED — files once, the record captured, not paused, no fee stop",
    o.posts.filter((p) => /\/apply\/submit$/.test(p.path)).length === 1 && o.r.capturedPermitNumber === RECORD && !o.r.pauseReason && !o.r.feeStop, brief(o));
}

console.log("\n3. The screenshot is masked: card box, password box, the account number's element");
{
  const browser = await chromium.launch();
  const pg = await browser.newPage();
  await pg.goto(`${base}/m/x/fees`);
  let seen: { masked: string[]; ok: boolean } = { masked: [], ok: false };
  const real = pg.screenshot.bind(pg);
  // A spy around the real screenshot: which elements does its mask cover?
  (pg as unknown as { screenshot: typeof pg.screenshot }).screenshot = async (opts?: Parameters<typeof pg.screenshot>[0]) => {
    const mask = (opts?.mask ?? []) as Array<{ evaluateAll: (fn: (els: Element[]) => string[]) => Promise<string[]> }>;
    const ids: string[] = [];
    for (const m of mask) ids.push(...await m.evaluateAll((els) => els.map((e) => e.id || e.tagName)));
    seen = { masked: ids, ok: true };
    return real(opts);
  };
  const file = `${process.env.REPLAY_RUN_DIR || "/tmp"}/fee-mask-${Date.now()}.png`;
  const out = await maskedFeeShot(pg, file, [ACCOUNT]);
  check("MASK: a picture was taken", !!out && fs.existsSync(out), out);
  for (const id of ["cc", "pw", "acct"]) check(`MASK: #${id} is masked`, seen.masked.includes(id), JSON.stringify(seen));
  const left = await pg.evaluate(() => document.querySelectorAll("[data-fee-stop-mask]").length);
  check("MASK: no marker attribute is left on the page", left === 0, String(left));
  await browser.close();
}

server.close();
if (failures) { console.error(`\n${failures} fee-stop check(s) FAILED.`); process.exit(1); }
console.log("\nAll fee-stop checks passed (real Chromium, local replicas, the real stage path).");
process.exit(0);
