// #569 — THE CONFIRMATION SCREENSHOT OF EVERY FILING, IN A REAL BROWSER.
//
// Owner, 2026-11-03: "take a screenshot on the confirmation screen, like 'your app / permit number is
// XYZ'". After a filing goes, the run waits for the confirmation page to settle and takes ONE masked
// full-page picture of it through #588's maskedFullPageScreenshot (the one masking path, rule 2); the
// backend files it on the project (backend/test/submissionConfirmation.test.ts). Rule 1: capture only —
// the fixture counts every POST it receives, and the picture adds none.
//
//   [1] APPROVED FINAL SUBMIT (stageWithRecipe — the real stage path — on local replicas):
//     MUST-PASS  powerclerk: a PowerClerk-like completion page ("Your application APP-112491 has been
//                submitted", the account number printed on it) → confirmationShotPath, a PNG named
//                zzz-confirmation-SUBMITTED.png, the account's box painted with the mask colour in the
//                PNG itself (and NOT in the run's unmasked outcome shot: the check bites), the record
//                number captured, EXACTLY ONE filing POST.
//     MUST-PASS  accela: an Accela-like completion page ("Record Number: 26-000123-STR", the meter
//                number printed) → the same, the meter's box masked.
//     MUST-EXCLUDE shadow: the completion page carries the account inside a CLOSED shadow root (the
//                mask cannot be proven) → no confirmationShotPath, confirmationShotRefused says why, the
//                outcome shot is kept, the record still captured.
//     MUST-EXCLUDE quiet: a completion page that neither confirms nor refuses → no confirmation
//                screenshot (only the outcome shot), never a number.
//   [2] THE HAND-OVER WINDOW (#378): the replay stages the review page and hands it over; the PERSON
//     clicks Submit; the runner's capture (index.ts armSubmitCapture) reads the completion page →
//     completionConfirmed, the number, and a masked confirmationShotPath (the account's box painted).
//     Automation clicks nothing: exactly one filing POST, the person's.
//
// Kill: recipeAdapter — drop captureConfirmationShot on "accepted" → [1] powerclerk/accela fail; take
// the picture with page.screenshot instead of maskedFullPageScreenshot → the mask-colour checks fail
// and [1] shadow keeps a picture; drop it in readSubmissionConfirmation → [2] fails.
//
//   npx tsx portal-bot/src/adapters/confirmationShot.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { armSubmitCapture, stageWithRecipe } from "../index";
import { unpaintedMaskBoxes } from "../secretMask";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Synthetic secrets (never a real account): what the run's field map carries.
const ACCOUNT = "7734009155";
const METER = "1009988776";
const FIELD_VALUES = { accountNumber: ACCOUNT, meterNumber: METER };
// Where each secret is painted on the completion pages: a fixed box, so the PNG can be read there.
const BOX = { x: 40, y: 320, width: 260, height: 32 };
const at = `position:absolute;left:${BOX.x}px;top:${BOX.y}px;width:${BOX.width}px;height:${BOX.height}px;margin:0;font:20px sans-serif;background:#fff;color:#000`;

const posts: Array<{ mode: string; path: string }> = [];
// A signed-in portal: the account menu is the signed-in signal the replay's login check reads.
const NAV = `<nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav>`;
const html = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;min-height:600px">${NAV}${body}</body></html>`;
const REVIEW = (mode: string): string => html("Review and Submit", `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
  <dl><dt>Applicant</dt><dd>Desmond Yarrowby</dd></dl>
  <form method="post" action="/m/${mode}/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`);
const COMPLETIONS: Record<string, string> = {
  // PowerClerk-like: the application id in the confirmation sentence, the account on the page.
  powerclerk: html("Application Submitted", `<h1>Application Submitted</h1><p>Thank you. Your application has been submitted.</p><p>Application ID: APP-112491</p>
    <p style="${at}" id="acct">Account: ${ACCOUNT.slice(0, 4)} ${ACCOUNT.slice(4, 7)} ${ACCOUNT.slice(7)}</p>`),
  // Accela-like: "Record Number:" and the record's discipline suffix, the meter on the page.
  accela: html("Record Submitted", `<h1>Your application has been submitted</h1><p>Record Number: 26-000123-STR</p><p>Record Type: Residential Solar</p>
    <p style="${at}" id="meter">Meter ${METER}</p>`),
  // The account where no script can tag it: a CLOSED shadow root.
  shadow: html("Application Submitted", `<h1>Application Submitted</h1><p>Thank you. Your application has been submitted.</p><p>Application ID: APP-112492</p><div id="host" style="${at}"></div>
    <script>document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = "<span>Account ${ACCOUNT}</span>";</script>`),
  // Neither a confirmation nor a refusal.
  quiet: html("Thank you", `<h1>Thank you</h1><p>We received your request.</p>`),
  // The hand-over replica's completion (PowerClerk-like).
  person: html("Application Submitted", `<h1>Application Submitted</h1><p>Thank you. Your application APP-778899 has been submitted.</p>
    <p style="${at}" id="acct">Account ${ACCOUNT}</p>`),
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  if (req.method !== "GET" && req.method !== "HEAD") posts.push({ mode, path: url.pathname });
  const send = (body: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (req.method === "POST" && rest === "apply/submit") { send(COMPLETIONS[mode] ?? COMPLETIONS.quiet); return; }
  if (mode) { send(REVIEW(mode)); return; }
  send(html("Portal", "<h1>Home</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeFor = (mode: string): PortalRecipe => ({
  id: `confirmation-shot-${mode}`, scopeType: "utility", profileKey: "or|fernhollow|", state: "OR", ahj: "", utility: "Fernhollow Power",
  portalPlatform: "fixture", portalUrl: `${base}/m/${mode}/review`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/m/${mode}/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep,
  ],
} as PortalRecipe);
const filingPosts = (mode: string, from: number): number => posts.slice(from).filter((p) => p.mode === mode && /\/apply\/submit$/.test(p.path)).length;
const isPng = (file: string): boolean => {
  try { return fs.readFileSync(file).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); } catch { return false; }
};

let runSeq = 0;
async function approved(mode: string): Promise<{ r: Record<string, unknown>; filings: number }> {
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  const before = posts.length;
  try {
    const runId = `run-confirmation-${mode}-${++runSeq}`;
    const r = await stageWithRecipe(recipeFor(mode), { id: `p-${mode}` } as ProjectRecord, FIELD_VALUES, {}, [], {
      autoSubmit: true, runApproval: { approver: "A. Operator", runId }, runId, headless: true,
    });
    await sleep(300);
    return { r, filings: filingPosts(mode, before) };
  } finally {
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
}
const brief = (o: { r: Record<string, unknown>; filings: number }): string => JSON.stringify({
  filings: o.filings, ok: o.r.ok, clicked: o.r.finalSubmitClicked, permit: o.r.capturedPermitNumber, conf: o.r.confirmationShotPath,
  refused: o.r.confirmationShotRefused, outcome: o.r.outcomeShotPath,
  msg: (Array.isArray(o.r.steps) ? (o.r.steps as Array<{ message?: string }>).map((s) => s.message).join(" | ") : "").slice(0, 400),
}).slice(0, 1200);

console.log("\n[1] APPROVED FINAL SUBMIT: the masked confirmation screenshot of the page the portal confirmed");
for (const [mode, number] of [["powerclerk", "APP-112491"], ["accela", "26-000123-STR"]] as const) {
  const o = await approved(mode);
  const shot = String(o.r.confirmationShotPath ?? "");
  const outcome = String(o.r.outcomeShotPath ?? "");
  check(`${mode}: exactly one filing POST (the approved click; the picture clicks nothing)`, o.filings === 1, brief(o));
  check(`${mode}: the number read off the page is captured (${number})`, o.r.capturedPermitNumber === number, brief(o));
  check(`${mode}: a confirmation screenshot was kept — a PNG named zzz-confirmation-SUBMITTED.png`,
    !!shot && path.basename(shot) === "zzz-confirmation-SUBMITTED.png" && isPng(shot) && !o.r.confirmationShotRefused, brief(o));
  check(`${mode}: …the outcome shot is kept beside it`, !!outcome && outcome !== shot && fs.existsSync(outcome), brief(o));
  if (shot && fs.existsSync(shot) && outcome && fs.existsSync(outcome)) {
    const maskedShort = await unpaintedMaskBoxes(shot, [BOX]).catch(() => -1);
    const outcomeShort = await unpaintedMaskBoxes(outcome, [BOX]).catch(() => -1);
    check(`${mode}: the secret's box is painted with the mask colour in the confirmation PNG (rule 2)`, maskedShort === 0, `unpainted=${maskedShort}`);
    check(`${mode}: …and NOT in the unmasked outcome shot (the check bites)`, outcomeShort === 1, `unpainted=${outcomeShort}`);
  }
}
{
  const o = await approved("shadow");
  check("shadow: one filing POST, the number captured", o.filings === 1 && o.r.capturedPermitNumber === "APP-112492", brief(o));
  check("shadow: MUST-EXCLUDE — a page whose secret the mask cannot prove keeps NO confirmation screenshot, and says why",
    !o.r.confirmationShotPath && /shadow/i.test(String(o.r.confirmationShotRefused ?? "")), brief(o));
  check("shadow: …the outcome shot is still kept", !!o.r.outcomeShotPath && fs.existsSync(String(o.r.outcomeShotPath)), brief(o));
  const dir = path.dirname(String(o.r.outcomeShotPath ?? ""));
  check("shadow: …and no confirmation file is left on disk", !fs.existsSync(path.join(dir, "zzz-confirmation-SUBMITTED.png")), dir);
}
{
  const o = await approved("quiet");
  check("quiet: MUST-EXCLUDE — a page that does not confirm the filing gets no confirmation screenshot and no number",
    o.filings === 1 && !o.r.confirmationShotPath && !o.r.confirmationShotRefused && !o.r.capturedPermitNumber, brief(o));
  check("quiet: …the outcome shot is kept", !!o.r.outcomeShotPath && fs.existsSync(String(o.r.outcomeShotPath)), brief(o));
}

console.log("\n[2] THE HAND-OVER WINDOW: the person's own submit, pictured masked");
{
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page: Page = await ctx.newPage();
    const before = posts.length;
    let clicked: Promise<void> | null = null;
    // The person clicks the portal's Submit once the run says the page is theirs (a trusted mouse click).
    const personClicks = async (): Promise<void> => {
      await sleep(300);
      const box = await page.locator("#btnSubmit").first().boundingBox();
      if (!box) throw new Error("no submit box");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    const adapter = new RecipeAdapter(recipeFor("person"), FIELD_VALUES, {}, {
      handOverReview: true,
      onProgress: (p) => { if (/the page is yours/i.test(String(p.message ?? "")) && !clicked) clicked = personClicks(); },
    });
    (adapter as unknown as { page: unknown }).page = page;
    const captures: Array<Record<string, unknown>> = [];
    const fill = await adapter.fillApplication({ id: "p-person" } as ProjectRecord);
    if (clicked) await (clicked as Promise<void>).catch(() => null);
    await armSubmitCapture(adapter, { onSubmitCaptured: (c) => { captures.push(c as unknown as Record<string, unknown>); } });
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000 && !captures.length) await sleep(100);
    const c = captures[0] ?? {};
    const detail = JSON.stringify({ fill: String(fill.message ?? "").slice(0, 200), captures, filings: filingPosts("person", before) }).slice(0, 1200);
    check("hand-over: the person's click filed once (automation clicked nothing)", filingPosts("person", before) === 1 && (fill.data as { finalSubmitClicked?: unknown } | undefined)?.finalSubmitClicked !== true, detail);
    check("hand-over: the capture read the completion page — completionConfirmed, the number APP-778899",
      c.completionConfirmed === true && c.recordNumber === "APP-778899" && c.confidence === "high", detail);
    const shot = String(c.confirmationShotPath ?? "");
    check("hand-over: a masked confirmation screenshot is handed to the caller (zzz-confirmation-PERSON_SUBMITTED.png)",
      !!shot && path.basename(shot) === "zzz-confirmation-PERSON_SUBMITTED.png" && isPng(shot), detail);
    if (shot && fs.existsSync(shot)) {
      const short = await unpaintedMaskBoxes(shot, [BOX]).catch(() => -1);
      check("hand-over: the account's box is painted with the mask colour in the PNG (rule 2)", short === 0, `unpainted=${short}`);
    }
    await adapter.stopAtReview().catch(() => null);
    await ctx.close().catch(() => null);
  } finally {
    await browser.close().catch(() => null);
  }
}

server.close();
console.log(`\n${total - failures}/${total} confirmation-shot checks passed.`);
if (failures) {
  console.error(`${failures} confirmation-shot check(s) FAILED.`);
  process.exit(1);
}
process.exit(0);
