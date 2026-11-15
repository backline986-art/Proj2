// A ONE-TIME SIGN-IN CODE IS A SECOND FACTOR, NOT A CARD (#238) — in real Chromium, against
// SYNTHETIC replicas (fake hosts, fake data; no live portal, nothing copied from a capture).
//
// The 2026-11-14 recipe audit (class C8, probe p8): Idaho DOPL recipe 7e90272b holds ONE recorded
// step, the post-login emailed "Security Code" (beside "Trust this device"), recorded as a
// sensitive fill. recipeAdapter's PAYMENT_FIELD carries "security code" as a CVV synonym and runAll
// asks it first, so the replay returned ok=true, stoppedAtPayment, "Replayed 0 recorded step(s);
// stopped at review … no mismatch" with 0 fields read: an MFA wall read as a clean staged filing.
//
//   MUST-PASS    the DOPL shape (Two-Step Verification, a Security Code box named only by its
//                <label for>, Trust this device, Log In, Resend) PAUSES as mfa_captcha, ok=false,
//                not stoppedAtPayment.
//   MUST-KEEP    "Security Code" on a card form still stops AT PAYMENT. Two families:
//     (a) the fee page PRINTS second-factor-like wording ("Enter the security code printed on the
//         back of your card" is in SECOND_FACTOR_TEXT_SOURCE), so only card context can veto:
//         card siblings on the page, a payment URL, a card number in a cross-origin child frame,
//         a card step of the same recorded form, a card-number frame mounted 1.5 s after load (the
//         bounded look), a card form in an open shadow root, a recorded "CVV Security Code", and a
//         fee page reached after the application was filled (its card form in a CLOSED shadow root,
//         which nothing can read: only "not at sign-in" can say card there);
//     (b) the #238 reviewers' fee pages with NO second-factor wording, which round 1 paused as
//         mfa_captcha on the mere absence of card context: a card-number frame mounted 500 ms and
//         1500 ms after load, a shadow-DOM card form, the rest of a card form drawn 5 s after its
//         code box, and card labels the shared words do not know ("Card / Expires (MM/YY) / ZIP Code", "Card Account Number /
//         Expiration Date / Card Security Code").
//   MUST-KEEP    nothing is typed into the code box or any card box, and no Log In / Resend press.
//
//   npx tsx portal-bot/src/adapters/mfaCodeNotPayment.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
let passes = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passes++; console.log(`  ok   - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const hits: string[] = [];
const STYLE = "<style>body{font:14px sans-serif;padding:16px} label{display:block;margin-top:8px}</style>";
const page = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title>${STYLE}</head><body>${body}</body></html>`;
// What a card form may print beside its CVV box. It matches SECOND_FACTOR_TEXT_SOURCE's "enter the
// security code", so on these pages the wording alone can never decide.
const SAYS = "<p>Enter the security code printed on the back of your card.</p>";

// DOPL's emailed-code step (the same shape identifierFirstLogin.dom.smoke.ts drives the login over).
const DOPL = page("Online Services", `<div id="pageForm">
  <h1>Two-Step Verification</h1>
  <p>An email with your Online Services security code was sent to d***@e***.test.</p>
  <label for="Dc-91">Security Code</label><input type="text" id="Dc-91" name="Dc-91" placeholder="Required" autocomplete="off">
  <input type="checkbox" id="Dc-c1"><label for="Dc-c1">Trust this device</label>
  <button type="button" id="mfaGo" onclick="fetch('/hit/mfa-login')">Log In</button>
  <p>Didn't receive your code?</p><a href="#" id="resend" onclick="fetch('/hit/resend');return false;">Resend security code</a>
</div>`);

// A fee step's card form on a path that is NOT a payment URL (Coos Bay's was CapFees.aspx): only the
// card siblings can say "card" here.
const CSC_FIELD = `<label for="csc">Security Code</label><input id="csc" name="csc">`;
const CARD_REST = `<label for="ccnum">Card Number</label><input id="ccnum" name="ccnum" autocomplete="cc-number">
  <label for="expm">Expiration Month</label><select id="expm"><option value=""></option><option>04</option></select>
  <label for="expy">Expiration Year</label><select id="expy"><option value=""></option><option>2029</option></select>
  <label for="noc">Name on Card</label><input id="noc" name="noc">`;
const CARD_FIELDS = `${CARD_REST}\n  ${CSC_FIELD}`;
const CARD_FORM = page("Fees", `<h2>Pay Fees</h2>${SAYS}<form>${CARD_FIELDS}</form>`);

// A lone code box with no card sibling, on a payment URL.
const PAY_URL_FORM = page("Payment", `<h2>Confirm</h2>${SAYS}<label for="csc">Security Code</label><input id="csc" name="csc">`);

// A hosted card form: the card number lives in a CROSS-ORIGIN child frame (localhost vs 127.0.0.1).
const hostedMain = (port: number): string => page("Fees", `<h2>Pay Fees</h2>${SAYS}
  <iframe id="cardFrame" src="http://localhost:${port}/hosted-card-frame" style="width:420px;height:90px;border:0"></iframe>
  <label for="csc">Security Code</label><input id="csc" name="csc">`);
const HOSTED_FRAME = page("card", `<label for="cn">Card Number</label><input id="cn" name="cardnumber" autocomplete="cc-number">`);

// A code box whose recorded form also held a card number the page has not drawn (yet): only the
// recording can say "card" here.
const SEGMENT_ONLY = page("Fees", `<h2>Pay Fees</h2>${SAYS}<label for="csc">Security Code</label><input id="csc" name="csc">
  <div style="display:none"><label for="ccnum">Card Number</label><input id="ccnum" name="ccnum"></div>`);

// A hosted card form whose cross-origin card-number frame is MOUNTED BY SCRIPT `delay` ms after load
// (Stripe / Braintree / CardConnect style); the main document holds only the expiry and the code.
const lateFrame = (port: number, delay: number, says: boolean): string => page("Fees", `<h2>Pay Fees</h2>${says ? SAYS : ""}
  <div id="cardSlot"></div>
  <label for="exp">Expiration (MM/YY)</label><input id="exp" name="exp">
  <label for="csc">Security Code</label><input id="csc" name="csc">
  <script>window.addEventListener("load", function () { setTimeout(function () {
    var f = document.createElement("iframe"); f.id = "cardFrame"; f.src = "http://localhost:${port}/hosted-card-frame";
    f.style.cssText = "width:420px;height:90px;border:0"; document.getElementById("cardSlot").appendChild(f);
  }, ${delay}); });</script>`);

// A web-component card form: every card field (the code box too) inside a shadow root.
const shadowForm = (mode: string, says: boolean): string => page("Fees", `<h2>Pay Fees</h2>${says ? SAYS : ""}<div id="cardHost"></div>
  <script>document.getElementById("cardHost").attachShadow({ mode: "${mode === "closed" ? "closed" : "open"}" }).innerHTML = ${JSON.stringify(CARD_FIELDS)};</script>`);

// A single-page app that shows the code box at once and draws the rest of its card form 5 s after load.
const SPA_LATE = page("Fees", `<h2>Pay Fees</h2>${CSC_FIELD}<div id="app"></div>
  <script>setTimeout(function () { document.getElementById("app").innerHTML = ${JSON.stringify(CARD_REST)}; }, 5000);</script>`);

// The step before a fee page: a plain Continue link (the reviewers reached the late-frame page by a click).
const startPage = (to: string): string => page("Fees", `<h2>Fees due</h2><a id="next" href="${to.replace(/"/g, "&quot;")}">Continue</a>`);

// Card labels the shared PAYMENT_WORDS does not know.
const LABELS_A3 = page("Fees", `<h2>Pay Fees</h2><form>
  <label for="card">Card</label><input id="card" name="card">
  <label for="exp">Expires (MM/YY)</label><input id="exp" name="exp">
  <label for="csc">Security Code</label><input id="csc" name="csc">
  <label for="zip">ZIP Code</label><input id="zip" name="zip">
</form>`);
const LABELS_A3B = page("Fees", `<h2>Pay Fees</h2><form>
  <label for="can">Card Account Number</label><input id="can" name="can">
  <label for="exd">Expiration Date</label><input id="exd" name="exd">
  <label for="csc">Card Security Code</label><input id="csc" name="csc">
</form>`);

// A saved card's CVV re-entry: the live box says only "Security Code"; the RECORDING named it a CVV.
const SAVED_CARD = page("Fees", `<h2>Pay Fees</h2><p>Pay with the saved card ending 1111.</p>${SAYS}
  <label for="csc">Security Code</label><input id="csc" name="csc">`);

// The application page a fee page follows.
const APPLY = page("Apply", `<h2>Project</h2><label for="desc">Project Description</label><input id="desc" name="desc">
  <a id="next" href="/permits/fees/shadow?mode=closed&says=1">Continue</a>`);

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const p = u.pathname;
  if (p.startsWith("/hit/")) { hits.push(p); res.writeHead(204); res.end(); return; }
  const port = (server.address() as { port: number }).port;
  const says = u.searchParams.get("says") === "1";
  const body = p === "/OnlineServices/_/" ? DOPL
    : p === "/permits/fees/step3" ? CARD_FORM
    : p === "/m/payment/confirm" ? PAY_URL_FORM
    : p === "/permits/fees/hosted" ? hostedMain(port)
    : p === "/hosted-card-frame" ? HOSTED_FRAME
    : p === "/permits/fees/segment" ? SEGMENT_ONLY
    : p === "/permits/fees/late" ? lateFrame(port, Number(u.searchParams.get("delay") ?? "0"), says)
    : p === "/permits/fees/shadow" ? shadowForm(String(u.searchParams.get("mode")), says)
    : p === "/permits/fees/spa" ? SPA_LATE
    : p === "/permits/fees/labels-a3" ? LABELS_A3
    : p === "/permits/fees/labels-a3b" ? LABELS_A3B
    : p === "/permits/fees/saved-card" ? SAVED_CARD
    : p === "/permits/apply" ? APPLY
    : p === "/permits/fees/start" ? startPage(String(u.searchParams.get("to") ?? "/"))
    : null;
  if (!body) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeOf = (id: string, steps: unknown[]): PortalRecipe => ({
  id, scopeType: "ahj", profileKey: "zz|city of example|example power", state: "ZZ",
  ahj: "City of Example", utility: "Example Power", portalPlatform: "auto-learned", portalUrl: `${base}/`,
  status: "complete", version: 1, steps: steps as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "electrical",
} as unknown as PortalRecipe);

// The recorded code step exactly as the DOPL recipe holds it: label + id fallback, sensitive, empty.
const codeStep = (css: string) => ({
  action: "fill", phase: "fill", note: "Security Code", value: "", sensitive: true,
  selector: { label: "Security Code", fallbacks: [{ css }] },
  fingerprint: { id: css.slice(1), name: css.slice(1), placeholder: "Required" },
});
// The same box on a card form, as a human-paid recording holds it.
const cvvStep = (note = "Security Code") => ({ ...codeStep("#csc"), note, selector: { label: note, fallbacks: [{ css: "#csc" }] }, value: "123", sensitive: false, fingerprint: undefined });
const gotoStep = (path: string) => ({ action: "goto", phase: "open", value: `${base}${path}`, note: "entry url" });

type Ran = { ok: boolean; message: string; pauseReason: string | null; data: Record<string, unknown>; ms: number };
const browser = await chromium.launch();
const replay = async (recipe: PortalRecipe, read: (pg: Page) => Promise<Record<string, string>>): Promise<Ran & { boxes: Record<string, string> }> => {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const pg = await context.newPage();
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = pg;
  const t0 = Date.now();
  const res = await adapter.fillApplication({} as never) as unknown as { ok: boolean; message?: string; pauseReason?: string | null; data?: Record<string, unknown> };
  const ms = Date.now() - t0;
  await pg.waitForTimeout(300);
  const boxes = await read(pg);
  await context.close();
  return { ok: res.ok, message: String(res.message ?? ""), pauseReason: res.pauseReason ?? null, data: res.data ?? {}, ms, boxes };
};
const valueOf = async (pg: Page, sel: string, frame?: string): Promise<string> =>
  await (frame ? pg.frameLocator(frame).locator(sel) : pg.locator(sel)).inputValue({ timeout: 3000 }).catch(() => "<gone>");
const brief = (r: Ran & { boxes: Record<string, string> }): string =>
  `ok=${r.ok} pauseReason=${String(r.pauseReason)} stoppedAtPayment=${String(r.data.stoppedAtPayment)} ms=${r.ms} boxes=${JSON.stringify(r.boxes)} message=${JSON.stringify(r.message.slice(0, 240))}`;

// ---- MUST-PASS: the DOPL shape pauses for the code ---------------------------------------------
{
  hits.length = 0;
  const r = await replay(recipeOf("dopl-7e90272b-shape", [
    gotoStep("/OnlineServices/_/#2"),
    codeStep("#Dc-91"),
  ]), async (pg) => ({ code: await valueOf(pg, "#Dc-91"), trust: String(await pg.locator("#Dc-c1").isChecked().catch(() => "<gone>")) }));
  console.log(`   DOPL: ${brief(r)}`);
  check("MUST-PASS (DOPL 7e90272b shape): the emailed Security Code PAUSES as mfa_captcha, never a clean ok=true stop",
    r.pauseReason === "mfa_captcha" && r.ok === false, brief(r));
  check("...and it is NOT reported as a payment stop", r.data.stoppedAtPayment !== true, brief(r));
  check("...and the pause names the second factor the page shows (Two-Step Verification)",
    /second factor/i.test(r.message) && /two-step verification/i.test(r.message), brief(r));
  check("MUST-KEEP: nothing typed into the code box, Trust this device left alone, Log In / Resend never pressed",
    r.boxes.code === "" && r.boxes.trust === "false" && hits.length === 0, `${brief(r)} hits=${JSON.stringify(hits)}`);
}

// ---- MUST-KEEP: a card's Security Code still stops at payment ------------------------------------
const cardBoxes = async (pg: Page): Promise<Record<string, string>> => ({
  csc: await valueOf(pg, "#csc"), ccnum: await valueOf(pg, "#ccnum"), expm: await valueOf(pg, "#expm"),
  expy: await valueOf(pg, "#expy"), noc: await valueOf(pg, "#noc"),
});
const atPayment = (label: string, r: Ran & { boxes: Record<string, string> }): void => {
  check(`MUST-KEEP (${label}): "Security Code" stops AT PAYMENT, not as a second factor`,
    r.data.stoppedAtPayment === true && r.pauseReason !== "mfa_captcha", brief(r));
  check(`MUST-KEEP (${label}): nothing typed into any box`,
    Object.values(r.boxes).every((v) => v === "" || v === "<gone>"), brief(r));
};
// The fixture itself: a hosted card frame must have loaded cross-origin, or its variant proves nothing.
const frameHostOf = (pg: Page): string => {
  const frameUrl = pg.frames().map((f) => f.url()).find((u) => u.includes("/hosted-card-frame")) ?? "";
  return frameUrl ? new URL(frameUrl).hostname : "<no frame>";
};

// (a) The page prints "Enter the security code ...": only card context may veto.
{
  // The code is the ONLY recorded step, so the card siblings ON THE PAGE are what decide.
  const r = await replay(recipeOf("card-page-siblings", [gotoStep("/permits/fees/step3"), cvvStep()]), cardBoxes);
  console.log(`   card form (page siblings): ${brief(r)}`);
  atPayment("card siblings on the page, which says \"Enter the security code\"", r);
}
{
  // The full human-paid recording, Security Code first (the order a learn records it in on some forms).
  const r = await replay(recipeOf("card-full-recording", [
    gotoStep("/permits/fees/step3"),
    cvvStep(),
    { action: "select", phase: "fill", note: "Expiration Month", value: "04", selector: { css: "#expm" } },
    { action: "select", phase: "fill", note: "Expiration Year", value: "2029", selector: { css: "#expy" } },
    { action: "fill", phase: "fill", note: "Card Number", value: "4111111111111111", selector: { css: "#ccnum" } },
    { action: "fill", phase: "fill", note: "Name on Card", value: "Test Payer", selector: { css: "#noc" } },
  ]), cardBoxes);
  console.log(`   card form (full recording): ${brief(r)}`);
  atPayment("the whole card form recorded", r);
}
{
  const r = await replay(recipeOf("card-pay-url", [gotoStep("/m/payment/confirm"), cvvStep()]), async (pg) => ({ csc: await valueOf(pg, "#csc") }));
  console.log(`   lone code on a payment URL: ${brief(r)}`);
  atPayment("a payment URL", r);
}
{
  const r = await replay(recipeOf("card-hosted-frame", [gotoStep("/permits/fees/hosted"), cvvStep()]), async (pg) =>
    ({ csc: await valueOf(pg, "#csc"), cn: await valueOf(pg, "#cn", "#cardFrame"), frameHost: frameHostOf(pg) }));
  console.log(`   card number in a cross-origin frame: ${brief(r)}`);
  check("fixture: the card number's frame loaded from another origin (localhost, the page is 127.0.0.1)", r.boxes.frameHost === "localhost", brief(r));
  delete r.boxes.frameHost;
  atPayment("card number in a cross-origin child frame", r);
}
{
  const r = await replay(recipeOf("card-recorded-segment", [
    gotoStep("/permits/fees/segment"),
    cvvStep(),
    { action: "fill", phase: "fill", note: "Card Number", value: "4111111111111111", selector: { css: "#ccnum" } },
  ]), async (pg) => ({ csc: await valueOf(pg, "#csc"), ccnum: await valueOf(pg, "#ccnum") }));
  console.log(`   card number only in the recorded form: ${brief(r)}`);
  atPayment("a card step of the same recorded form", r);
}
{
  // The bounded look: the card-number frame arrives 1.5 s after load, after the step is reached.
  const r = await replay(recipeOf("card-late-frame-says", [gotoStep("/permits/fees/late?delay=1500&says=1"), cvvStep()]), async (pg) =>
    ({ csc: await valueOf(pg, "#csc"), cn: await valueOf(pg, "#cn", "#cardFrame"), frameHost: frameHostOf(pg) }));
  console.log(`   card-number frame mounted 1500 ms after load, page says "Enter the security code": ${brief(r)}`);
  check("fixture: the late card frame loaded from another origin", r.boxes.frameHost === "localhost", brief(r));
  delete r.boxes.frameHost;
  atPayment("a card-number frame mounted 1.5 s after load, with second-factor-like wording", r);
}
{
  const r = await replay(recipeOf("card-open-shadow-says", [gotoStep("/permits/fees/shadow?mode=open&says=1"), cvvStep()]), cardBoxes);
  console.log(`   card form in an open shadow root, page says "Enter the security code": ${brief(r)}`);
  atPayment("a card form in an open shadow root, with second-factor-like wording", r);
}
{
  // The recording named the box a CVV; the live box says only "Security Code" and nothing else on
  // the page reads as a card field.
  const r = await replay(recipeOf("card-recorded-cvv", [gotoStep("/permits/fees/saved-card"), cvvStep("CVV Security Code")]), async (pg) => ({ csc: await valueOf(pg, "#csc") }));
  console.log(`   recorded "CVV Security Code", live label "Security Code": ${brief(r)}`);
  atPayment("a recorded \"CVV Security Code\" whose live box says only \"Security Code\"", r);
}
{
  // A fee page reached AFTER the application was filled; its card form sits in a CLOSED shadow
  // root, which no reading can open. Only "not at sign-in" can say card here.
  const r = await replay(recipeOf("card-after-filled-application", [
    gotoStep("/permits/apply"),
    { action: "fill", phase: "fill", note: "Project Description", value: "Rooftop PV (synthetic)", selector: { css: "#desc" } },
    { action: "click", phase: "fill", note: "advance: Continue", selector: { css: "#next", text: "Continue" } },
    cvvStep(),
  ]), async (pg) => ({ url: new URL(pg.url()).pathname, csc: await valueOf(pg, "#csc") }));
  console.log(`   fee page after a filled application, card form in a closed shadow root: ${brief(r)}`);
  check("fixture: the run reached the fee page", r.boxes.url === "/permits/fees/shadow", brief(r));
  delete r.boxes.url;
  atPayment("a fee page after the application was filled (card form unreadable)", r);
}

// (b) The #238 reviewers' fee pages, no second-factor wording.
for (const delay of [500, 1500]) {
  // Reached by a plain Continue click, as the reviewer's fixture was (a click carries no entry, so
  // the code box is still "at sign-in" and only the missing wording keeps the payment stop).
  const r = await replay(recipeOf(`card-late-frame-${delay}`, [
    gotoStep(`/permits/fees/start?to=${encodeURIComponent(`/permits/fees/late?delay=${delay}`)}`),
    { action: "click", phase: "fill", note: "advance: Continue", selector: { css: "#next", text: "Continue" } },
    cvvStep(),
  ]), async (pg) => ({ url: new URL(pg.url()).pathname, csc: await valueOf(pg, "#csc"), cn: await valueOf(pg, "#cn", "#cardFrame"), exp: await valueOf(pg, "#exp") }));
  console.log(`   card-number frame mounted ${delay} ms after load: ${brief(r)}`);
  check(`fixture: the run reached the late-frame fee page (${delay} ms)`, r.boxes.url === "/permits/fees/late", brief(r));
  delete r.boxes.url;
  atPayment(`a card-number frame mounted ${delay} ms after load`, r);
}
{
  const r = await replay(recipeOf("card-open-shadow", [gotoStep("/permits/fees/shadow?mode=open"), cvvStep()]), cardBoxes);
  console.log(`   card form in an open shadow root: ${brief(r)}`);
  atPayment("a shadow-DOM card form", r);
}
{
  const r = await replay(recipeOf("card-spa-late", [gotoStep("/permits/fees/spa"), cvvStep()]), cardBoxes);
  console.log(`   code box at once, rest of the card form drawn 5 s after load: ${brief(r)}`);
  atPayment("the rest of a card form drawn 5 s after the code box", r);
}
{
  const r = await replay(recipeOf("card-labels-a3", [gotoStep("/permits/fees/labels-a3"), cvvStep()]), async (pg) =>
    ({ card: await valueOf(pg, "#card"), exp: await valueOf(pg, "#exp"), csc: await valueOf(pg, "#csc"), zip: await valueOf(pg, "#zip") }));
  console.log(`   Card / Expires (MM/YY) / Security Code / ZIP Code: ${brief(r)}`);
  atPayment("card labels Card / Expires (MM/YY) / ZIP Code", r);
}
{
  const r = await replay(recipeOf("card-labels-a3b", [gotoStep("/permits/fees/labels-a3b"), cvvStep("Card Security Code")]), async (pg) =>
    ({ can: await valueOf(pg, "#can"), exd: await valueOf(pg, "#exd"), csc: await valueOf(pg, "#csc") }));
  console.log(`   Card Account Number / Expiration Date / Card Security Code: ${brief(r)}`);
  atPayment("card labels Card Account Number / Expiration Date / Card Security Code", r);
}

await browser.close();
server.close();
console.log(`\n${passes} passed, ${failures} failed (of ${passes + failures}).`);
if (failures) { console.error(`${failures} MFA-vs-payment check(s) FAILED.`); process.exit(1); }
console.log("All MFA-vs-payment checks passed (real Chromium).");
process.exit(0);
