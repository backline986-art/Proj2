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
//   MUST-KEEP    "Security Code" on a card form still stops AT PAYMENT, whichever reading supplies
//                the card context: card siblings on the page (the code is the only recorded step,
//                so the recipe cannot be what decides), a payment URL, a card number in a cross-
//                origin child frame (a hosted card form), or a card step of the same recorded form.
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
const CARD_FORM = page("Fees", `<h2>Pay Fees</h2><form>
  <label for="ccnum">Card Number</label><input id="ccnum" name="ccnum">
  <label for="expm">Expiration Month</label><select id="expm"><option value=""></option><option>04</option></select>
  <label for="expy">Expiration Year</label><select id="expy"><option value=""></option><option>2029</option></select>
  <label for="csc">Security Code</label><input id="csc" name="csc">
  <label for="noc">Name on Card</label><input id="noc" name="noc">
</form>`);

// A lone code box with no card sibling, on a payment URL.
const PAY_URL_FORM = page("Payment", `<h2>Confirm</h2><label for="csc">Security Code</label><input id="csc" name="csc">`);

// A hosted card form: the card number lives in a CROSS-ORIGIN child frame (localhost vs 127.0.0.1).
const hostedMain = (port: number): string => page("Fees", `<h2>Pay Fees</h2>
  <iframe id="cardFrame" src="http://localhost:${port}/hosted-card-frame" style="width:420px;height:90px;border:0"></iframe>
  <label for="csc">Security Code</label><input id="csc" name="csc">`);
const HOSTED_FRAME = page("card", `<label for="cn">Card Number</label><input id="cn" name="cardnumber" autocomplete="cc-number">`);

// A code box whose recorded form also held a card number the page has not drawn (yet): only the
// recording can say "card" here.
const SEGMENT_ONLY = page("Fees", `<h2>Pay Fees</h2><label for="csc">Security Code</label><input id="csc" name="csc">
  <div style="display:none"><label for="ccnum">Card Number</label><input id="ccnum" name="ccnum"></div>`);

const server = http.createServer((req, res) => {
  const p = (req.url ?? "/").split(/[?#]/)[0];
  if (p.startsWith("/hit/")) { hits.push(p); res.writeHead(204); res.end(); return; }
  const port = (server.address() as { port: number }).port;
  const body = p === "/OnlineServices/_/" ? DOPL
    : p === "/permits/fees/step3" ? CARD_FORM
    : p === "/m/payment/confirm" ? PAY_URL_FORM
    : p === "/permits/fees/hosted" ? hostedMain(port)
    : p === "/hosted-card-frame" ? HOSTED_FRAME
    : p === "/permits/fees/segment" ? SEGMENT_ONLY
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

type Ran = { ok: boolean; message: string; pauseReason: string | null; data: Record<string, unknown> };
const browser = await chromium.launch();
const replay = async (recipe: PortalRecipe, read: (pg: Page) => Promise<Record<string, string>>): Promise<Ran & { boxes: Record<string, string> }> => {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const pg = await context.newPage();
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = pg;
  const res = await adapter.fillApplication({} as never) as unknown as { ok: boolean; message?: string; pauseReason?: string | null; data?: Record<string, unknown> };
  await pg.waitForTimeout(300);
  const boxes = await read(pg);
  await context.close();
  return { ok: res.ok, message: String(res.message ?? ""), pauseReason: res.pauseReason ?? null, data: res.data ?? {}, boxes };
};
const valueOf = async (pg: Page, sel: string, frame?: string): Promise<string> =>
  await (frame ? pg.frameLocator(frame).locator(sel) : pg.locator(sel)).inputValue({ timeout: 3000 }).catch(() => "<gone>");
const brief = (r: Ran & { boxes: Record<string, string> }): string =>
  `ok=${r.ok} pauseReason=${String(r.pauseReason)} stoppedAtPayment=${String(r.data.stoppedAtPayment)} boxes=${JSON.stringify(r.boxes)} message=${JSON.stringify(r.message.slice(0, 240))}`;

// ---- MUST-PASS: the DOPL shape pauses for the code ---------------------------------------------
{
  hits.length = 0;
  const r = await replay(recipeOf("dopl-7e90272b-shape", [
    { action: "goto", phase: "open", value: `${base}/OnlineServices/_/#2`, note: "entry url" },
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
{
  // The code is the ONLY recorded step, so the card siblings ON THE PAGE are what decide.
  const r = await replay(recipeOf("card-page-siblings", [
    { action: "goto", phase: "open", value: `${base}/permits/fees/step3`, note: "entry url" },
    { ...codeStep("#csc"), value: "123", sensitive: false, fingerprint: undefined },
  ]), cardBoxes);
  console.log(`   card form (page siblings): ${brief(r)}`);
  atPayment("card siblings on the page", r);
}
{
  // The full human-paid recording, Security Code first (the order a learn records it in on some forms).
  const r = await replay(recipeOf("card-full-recording", [
    { action: "goto", phase: "open", value: `${base}/permits/fees/step3`, note: "entry url" },
    { ...codeStep("#csc"), value: "123", sensitive: false, fingerprint: undefined },
    { action: "select", phase: "fill", note: "Expiration Month", value: "04", selector: { css: "#expm" } },
    { action: "select", phase: "fill", note: "Expiration Year", value: "2029", selector: { css: "#expy" } },
    { action: "fill", phase: "fill", note: "Card Number", value: "4111111111111111", selector: { css: "#ccnum" } },
    { action: "fill", phase: "fill", note: "Name on Card", value: "Test Payer", selector: { css: "#noc" } },
  ]), cardBoxes);
  console.log(`   card form (full recording): ${brief(r)}`);
  atPayment("the whole card form recorded", r);
}
{
  const r = await replay(recipeOf("card-pay-url", [
    { action: "goto", phase: "open", value: `${base}/m/payment/confirm`, note: "entry url" },
    { ...codeStep("#csc"), value: "123", sensitive: false, fingerprint: undefined },
  ]), async (pg) => ({ csc: await valueOf(pg, "#csc") }));
  console.log(`   lone code on a payment URL: ${brief(r)}`);
  atPayment("a payment URL", r);
}
{
  const r = await replay(recipeOf("card-hosted-frame", [
    { action: "goto", phase: "open", value: `${base}/permits/fees/hosted`, note: "entry url" },
    { ...codeStep("#csc"), value: "123", sensitive: false, fingerprint: undefined },
  ]), async (pg) => {
    // The fixture itself: the card frame must have loaded cross-origin, or this variant proves nothing.
    const frameUrl = pg.frames().map((f) => f.url()).find((u) => u.includes("/hosted-card-frame")) ?? "";
    return { csc: await valueOf(pg, "#csc"), cn: await valueOf(pg, "#cn", "#cardFrame"), frameHost: frameUrl ? new URL(frameUrl).hostname : "<no frame>" };
  });
  console.log(`   card number in a cross-origin frame: ${brief(r)}`);
  check("fixture: the card number's frame loaded from another origin (localhost, the page is 127.0.0.1)", r.boxes.frameHost === "localhost", brief(r));
  delete r.boxes.frameHost;
  atPayment("card number in a cross-origin child frame", r);
}
{
  const r = await replay(recipeOf("card-recorded-segment", [
    { action: "goto", phase: "open", value: `${base}/permits/fees/segment`, note: "entry url" },
    { ...codeStep("#csc"), value: "123", sensitive: false, fingerprint: undefined },
    { action: "fill", phase: "fill", note: "Card Number", value: "4111111111111111", selector: { css: "#ccnum" } },
  ]), async (pg) => ({ csc: await valueOf(pg, "#csc"), ccnum: await valueOf(pg, "#ccnum") }));
  console.log(`   card number only in the recorded form: ${brief(r)}`);
  atPayment("a card step of the same recorded form", r);
}

await browser.close();
server.close();
console.log(`\n${passes} passed, ${failures} failed (of ${passes + failures}).`);
if (failures) { console.error(`${failures} MFA-vs-payment check(s) FAILED.`); process.exit(1); }
console.log("All MFA-vs-payment checks passed (real Chromium).");
process.exit(0);
