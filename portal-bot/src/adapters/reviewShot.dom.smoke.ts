// #316 — A REPLAY THAT STOPS FOR A PERSON PICTURES THE PAGE IT STOPPED ON, MASKED, IN A REAL BROWSER.
//
// The NEM replay of 2026-10-13 stopped at review as designed but reported no outcome shot, so the run
// row's screenshots_path stayed empty and the dashboard's review screenshot 404'd for the filing a
// person was about to submit. The run now takes ONE full-page picture of the page it stopped on through
// #588's maskedFullPageScreenshot (the one masking path, rule 2) and reports it as the run's outcome
// shot — kept only when the mask was proven. The backend half (the row, the route, the card) is
// backend/test/reviewScreenshot.test.ts. Rule 1: capture only — the fixture counts every POST.
//
//   MUST-PASS  review: a review page with the account number printed on it → outcomeShotPath is a PNG
//              named zzz-review.png in the run's folder, the account's box painted with the mask
//              colour in the PNG itself, no reviewShotRefused, NO POST at all.
//   MUST-EXCLUDE shadow: the account inside a CLOSED shadow root (the mask cannot be proven) → no
//              outcome shot, reviewShotRefused says why, and no zzz-review.png is left on disk.
//   MUST-PASS  unmasked check bites: a plain page.screenshot of the same review page leaves the
//              account's box unpainted (so the mask-colour check above can fail).
//
// Kill: recipeAdapter — drop the captureReviewShot call → [review] fails (no outcome shot); take it with
// page.screenshot instead of maskedFullPageScreenshot → [review] mask check fails and [shadow] keeps a
// picture.
//
//   npx tsx portal-bot/src/adapters/reviewShot.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import { unpaintedMaskBoxes } from "../secretMask";
import { REVIEW_SHOT_FILE } from "./recipeAdapter";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Synthetic secrets (never a real account).
const ACCOUNT = "7734009155";
const METER = "1009988776";
const FIELD_VALUES = { accountNumber: ACCOUNT, meterNumber: METER };
const BOX = { x: 40, y: 320, width: 260, height: 32 };
const at = `position:absolute;left:${BOX.x}px;top:${BOX.y}px;width:${BOX.width}px;height:${BOX.height}px;margin:0;font:20px sans-serif;background:#fff;color:#000`;

const posts: Array<{ mode: string; path: string }> = [];
const NAV = `<nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav>`;
const html = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;min-height:600px">${NAV}${body}</body></html>`;
const SUBMIT = (mode: string): string => `<form method="post" action="/m/${mode}/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
const REVIEWS: Record<string, (mode: string) => string> = {
  review: (mode) => html("Review and Submit", `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
    <dl><dt>Applicant</dt><dd>Desmond Yarrowby</dd></dl>${SUBMIT(mode)}
    <p style="${at}" id="acct">Account: ${ACCOUNT.slice(0, 4)} ${ACCOUNT.slice(4, 7)} ${ACCOUNT.slice(7)}</p>`),
  shadow: (mode) => html("Review and Submit", `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
    <dl><dt>Applicant</dt><dd>Desmond Yarrowby</dd></dl>${SUBMIT(mode)}<div id="host" style="${at}"></div>
    <script>document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = "<span>Account ${ACCOUNT}</span>";</script>`),
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  if (req.method !== "GET" && req.method !== "HEAD") posts.push({ mode, path: url.pathname });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(REVIEWS[mode] ? REVIEWS[mode](mode) : html("Portal", "<h1>Home</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeFor = (mode: string): PortalRecipe => ({
  id: `review-shot-${mode}`, scopeType: "utility", profileKey: "or|fernhollow|", state: "OR", ahj: "", utility: "Fernhollow Power",
  portalPlatform: "fixture", portalUrl: `${base}/m/${mode}/review`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/m/${mode}/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep,
  ],
} as PortalRecipe);
const isPng = (file: string): boolean => {
  try { return fs.readFileSync(file).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); } catch { return false; }
};

let runSeq = 0;
async function staged(mode: string): Promise<{ r: Record<string, unknown>; posts: number }> {
  const before = posts.length;
  const runId = `run-review-shot-${mode}-${++runSeq}`;
  const r = await stageWithRecipe(recipeFor(mode), { id: `p-${mode}` } as ProjectRecord, FIELD_VALUES, {}, [], { runId, headless: true });
  return { r, posts: posts.slice(before).filter((p) => p.mode === mode).length };
}
const reviewStep = (r: Record<string, unknown>): Record<string, unknown> =>
  ((Array.isArray(r.steps) ? r.steps : []) as Array<{ data?: Record<string, unknown> }>).map((s) => s.data ?? {}).filter((d) => "reviewShotRefused" in d || "outcomeShotPath" in d).pop() ?? {};
const brief = (o: { r: Record<string, unknown>; posts: number }): string => JSON.stringify({
  posts: o.posts, ok: o.r.ok, clicked: o.r.finalSubmitClicked, outcome: o.r.outcomeShotPath, evidence: o.r.evidenceDir,
  refused: reviewStep(o.r).reviewShotRefused,
  msg: (Array.isArray(o.r.steps) ? (o.r.steps as Array<{ message?: string }>).map((s) => s.message).join(" | ") : "").slice(0, 400),
}).slice(0, 1200);

console.log("\n[review] a replay that stops at review pictures the review page, masked");
{
  const o = await staged("review");
  const shot = String(o.r.outcomeShotPath ?? "");
  check("review: the run stopped at review — nothing clicked, NO POST", o.posts === 0 && o.r.finalSubmitClicked !== true, brief(o));
  check(`review: the outcome shot is the masked review picture — a PNG named ${REVIEW_SHOT_FILE} in the run's folder`,
    !!shot && path.basename(shot) === REVIEW_SHOT_FILE && isPng(shot) && path.dirname(shot) === String(o.r.evidenceDir ?? ""), brief(o));
  check("review: no refusal reported", !reviewStep(o.r).reviewShotRefused, brief(o));
  if (shot && fs.existsSync(shot)) {
    const unpainted = await unpaintedMaskBoxes(shot, [BOX]).catch(() => -1);
    check("review: the account's box is painted with the mask colour in the PNG (rule 2)", unpainted === 0, `unpainted=${unpainted}`);
  }
}

console.log("\n[shadow] a review page the mask cannot prove keeps no picture");
{
  const o = await staged("shadow");
  check("shadow: the run stopped at review — NO POST", o.posts === 0 && o.r.finalSubmitClicked !== true, brief(o));
  check("shadow: MUST-EXCLUDE — no outcome shot, and reviewShotRefused says why",
    !o.r.outcomeShotPath && /shadow/i.test(String(reviewStep(o.r).reviewShotRefused ?? "")), brief(o));
  const dir = String(o.r.evidenceDir ?? "");
  check("shadow: …and no review picture is left on disk", !dir || !fs.existsSync(path.join(dir, REVIEW_SHOT_FILE)), dir);
}

console.log("\n[bite] an unmasked picture of the same page leaves the account's box unpainted");
{
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/m/review/review`);
    const dir = fs.mkdtempSync(path.join(process.env.REPLAY_RUN_DIR || path.join(process.cwd(), "data", "replay-runs"), "review-shot-bite-"));
    const file = path.join(dir, "unmasked.png");
    await page.screenshot({ path: file, fullPage: true, scale: "css" });
    const unpainted = await unpaintedMaskBoxes(file, [BOX]).catch(() => -1);
    check("bite: the unmasked screenshot's box is NOT the mask colour (the mask check can fail)", unpainted === 1, `unpainted=${unpainted}`);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    await browser.close().catch(() => null);
  }
}

server.close();
console.log(`\n${total - failures}/${total} review-shot checks passed.`);
if (failures) {
  console.error(`${failures} review-shot check(s) FAILED.`);
  process.exit(1);
}
process.exit(0);
