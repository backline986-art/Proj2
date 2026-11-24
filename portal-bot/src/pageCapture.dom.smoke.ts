// PAGE CAPTURES IN A REAL BROWSER (pageCapture.ts).
//
// Owner, 2026-11-24, on Bend's location step: "why can't we see the pages better by default?" Local
// learns, recordings and replays now keep a masked picture and a trimmed snapshot of each distinct
// portal page. These fixtures stand in for a portal (a CityView-like location step); nothing here
// leaves 127.0.0.1.
//
//   [A] MUST-PASS    the location step is captured: a PNG, the known account printed on the page
//                    painted with the mask colour IN THE PNG, an account box holding a number the run
//                    did NOT know (the page's own secret field) painted too; the snapshot names the
//                    controls and buttons a reviewer asks about.
//       MUST-EXCLUDE the snapshot holds no account, meter, password or record reference; the live
//                    page is left exactly as it was (values in place, no mask tags).
//   [B] MUST-PASS    the same step again (another job's values typed): "seen", no new picture.
//   [C] MUST-EXCLUDE a page the mask cannot prove (the account in a CLOSED shadow root): no picture,
//                    the snapshot says why.
//   [D] MUST-EXCLUDE onlyWhenQuiet: a focused box or an open suggestion list -> nothing captured.
//   [E] MUST-PASS    the recorder (armRecorder with a page log) captures each page the person loads,
//                    on its own, and still records the person's steps.
//   [F] MUST-PASS    a replay (stageWithRecipe) captures the pages it walks, kind "replay".
//
// Kill: pass [] instead of the run's secrets in capture() -> [A] printed-account box fails; drop the
// page's own secret values (secretValues) -> [A] unknown-account box fails; take the picture with
// page.screenshot -> [A] and [C] fail; drop the onlyWhenQuiet check -> [D] fails; drop the recorder's
// load hook -> [E] fails; drop the capture in recipeAdapter.capturePageShot -> [F] fails.
//
//   npx tsx portal-bot/src/pageCapture.dom.smoke.ts
import "./smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { PageCaptureLog, pageCapturesDir } from "./pageCapture";
import { armRecorder } from "./recordRecipe";
import { unpaintedMaskBoxes } from "./secretMask";
import { stageWithRecipe } from "./index";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Synthetic values only.
const ACCOUNT = "7734009155";
const UNKNOWN_ACCOUNT = "5550001111";
const PASSWORD = "Hunter2Zebra!";
const BOX = { x: 40, y: 700, width: 300, height: 32 };
const ACCT_INPUT = { x: 40, y: 760, width: 300, height: 30 };
const at = (b: typeof BOX): string => `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;margin:0;box-sizing:border-box;font:18px sans-serif;background:#fff;color:#000`;

// A signed-in portal: the account menu is the signed-in signal the replay's login check reads.
const NAV = `<nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;min-height:900px;position:relative">${NAV}${body}</body></html>`;
const LOCATION = page("Permit Application | City of Fernhollow", `
  <h2>Location</h2>
  <p>Enter the location for the subject property by using the Search or Map tools below.</p>
  <button type="button">FIND LOCATIONS NEAR ME</button> <button type="button">FIND LOCATION IN MAP</button>
  <label for="ltype">Location Type(s) to Search For:</label>
  <select id="ltype"><option>All</option><option>Address</option><option>Tax Lot</option></select>
  <label for="search">Search for location:</label> <input id="search" type="text" value="">
  <ul id="suggest" role="listbox" style="display:none"><li role="option">101 Fernhollow Way</li></ul>
  <button type="button" id="cant">CAN'T FIND ADDRESS?</button>
  <label for="pw">Portal password</label> <input id="pw" type="password" value="${PASSWORD}">
  <p style="${at(BOX)}" id="acct">Account: ${ACCOUNT}</p>
  <label for="acctno" style="position:absolute;left:360px;top:760px">Account Number</label>
  <input id="acctno" name="accountNumber" type="text" value="${UNKNOWN_ACCOUNT}" style="${at(ACCT_INPUT)}">
  <a href="/contacts?referenceNumber=TMPPR20260017175&isstep=True" id="next">NEXT STEP</a>`);
const CONTACTS = page("Permit Application | City of Fernhollow", `<h2>Contacts</h2><label for="cn">Contact name</label><input id="cn"><a href="/location?referenceNumber=TMPPR20260017175" id="prev">PREVIOUS STEP</a>`);
// The replay's copy of the step: no password box (a password box reads as a login page to the replay).
const REPLAY_LOC = page("Permit Application | City of Fernhollow", `<h2>Location</h2>
  <label for="search">Search for location:</label> <input id="search" type="text" value="">
  <a href="/contacts?referenceNumber=TMPPR20260017175&isstep=True" id="next">NEXT STEP</a>`);
const SHADOW = page("Review", `<h2>Review</h2><div id="host" style="${at(BOX)}"></div>
  <script>document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = "<span>Account ${ACCOUNT}</span>";</script>`);
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const body = url.pathname.startsWith("/contacts") ? CONTACTS : url.pathname.startsWith("/r/location") ? REPLAY_LOC : url.pathname.startsWith("/shadow") ? SHADOW : LOCATION;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const LOC_URL = `${base}/location?referenceNumber=TMPPR20260017175&isstep=True`;

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const runLines = (slug: string): Array<Record<string, unknown>> => {
  try { return fs.readFileSync(path.join(pageCapturesDir(), slug, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

const browser = await chromium.launch();
try {
  console.log("\n[A] the location step, captured and masked");
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(LOC_URL);
  const log = PageCaptureLog.start({ kind: "learn", portal: "City of Fernhollow", secrets: () => [ACCOUNT] })!;
  const a = await log.capture(p, "p001-before-Location");
  check("captured, with a picture", a.status === "captured" && !!a.png && fs.existsSync(a.png), JSON.stringify(a));
  // Where the two boxes are drawn, read off the page (page coordinates: the picture is full-page).
  const boxOf = (sel: string): Promise<typeof BOX> => p.evaluate((s) => {
    const r = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  }, sel);
  if (a.png) {
    check("the known account printed on the page is painted in the PNG", await unpaintedMaskBoxes(a.png, [await boxOf("#acct")]).catch(() => -1) === 0);
    check("an account box holding a number the run did not know is painted too", await unpaintedMaskBoxes(a.png, [await boxOf("#acctno")]).catch(() => -1) === 0);
    check("the password box is painted too", await unpaintedMaskBoxes(a.png, [await boxOf("#pw")]).catch(() => -1) === 0);
  }
  const snapText = a.json ? fs.readFileSync(a.json, "utf8") : "";
  const snap = a.json ? readJson(a.json) : {};
  check("snapshot names the step's controls", snapText.includes("Search for location:") && snapText.includes("Location Type(s) to Search For:"), snapText.slice(0, 300));
  check("snapshot names the buttons", snapText.includes("CAN'T FIND ADDRESS?") && snapText.includes("FIND LOCATION IN MAP") && snapText.includes("NEXT STEP"));
  check("snapshot keeps the select's options", snapText.includes("Tax Lot"));
  check("snapshot marks the account box and the password box secret", /"label": "Account Number"[^}]*"secret": true/.test(snapText) && /"type": "password"[^}]*"secret": true/.test(snapText), snapText.slice(0, 200));
  check("snapshot holds no account, password or record reference", !snapText.includes(ACCOUNT) && !snapText.includes(UNKNOWN_ACCOUNT) && !snapText.includes(PASSWORD) && !snapText.includes("TMPPR"));
  check("snapshot URL keeps the path and the plain words", String(snap.url ?? "").endsWith("/location?referenceNumber=…&isstep=True"), String(snap.url));
  check("snapshot says the picture was masked", (snap.shot as { masked?: boolean } | undefined)?.masked === true, JSON.stringify(snap.shot));
  const live = await p.evaluate(() => ({
    acct: (document.getElementById("acctno") as HTMLInputElement).value,
    pw: (document.getElementById("pw") as HTMLInputElement).value,
    tags: document.querySelectorAll("[data-al-secret], [data-al-secret-check], [data-invisible]").length,
  }));
  check("the live page is untouched (values in place, no tags left)", live.acct === UNKNOWN_ACCOUNT && live.pw === PASSWORD && live.tags === 0, JSON.stringify(live));

  console.log("\n[B] the same step on another job");
  const mtime = a.png ? fs.statSync(a.png).mtimeMs : 0;
  await p.fill("#search", "101 Fernhollow Way");
  await p.locator("h2").click();
  const b = await log.capture(p, "p001-after-Location");
  check("same shape: seen, no new picture", b.status === "seen" && b.fp === a.fp && (!a.png || fs.statSync(a.png).mtimeMs === mtime), JSON.stringify(b));
  const log2 = PageCaptureLog.start({ kind: "replay", portal: "City of Fernhollow", secrets: () => [ACCOUNT] })!;
  const b2 = await log2.capture(p, "next run");
  check("a later run within the refresh window: seen", b2.status === "seen" && b2.fp === a.fp, JSON.stringify(b2));

  console.log("\n[C] a page the mask cannot prove");
  await p.goto(`${base}/shadow`);
  const c = await log.capture(p, "review");
  const cs = c.json ? readJson(c.json) : {};
  check("no picture, and the snapshot says why", c.status === "captured" && !c.png && !fs.existsSync(path.join(path.dirname(c.json ?? ""), `${c.fp}.png`))
    && (cs.shot as { masked?: boolean; refused?: string } | undefined)?.masked === false && /shadow root/.test(String((cs.shot as { refused?: string } | undefined)?.refused)), JSON.stringify(c) + JSON.stringify(cs.shot));

  console.log("\n[D] never while the person is typing or choosing");
  const quietLog = PageCaptureLog.start({ kind: "record", portal: "Quiet Check", secrets: () => [] })!;
  await p.goto(LOC_URL);
  await p.focus("#search");
  const d1 = await quietLog.capture(p, "typing", { onlyWhenQuiet: true });
  check("a focused box: skipped", d1.status === "skipped" && /focused|open/.test(String(d1.why)), JSON.stringify(d1));
  await p.locator("h2").click();
  await p.evaluate(() => { (document.getElementById("suggest") as HTMLElement).style.display = "block"; });
  const d2 = await quietLog.capture(p, "list open", { onlyWhenQuiet: true });
  check("an open suggestion list: skipped", d2.status === "skipped", JSON.stringify(d2));
  check("nothing written for the quiet check", !fs.existsSync(path.join(pageCapturesDir(), "quiet-check", "pages")));
  await ctx.close();

  console.log("\n[E] the recorder captures each page the person loads");
  const rctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const rp = await rctx.newPage();
  const recLog = PageCaptureLog.start({ kind: "record", portal: "Recorder Fixture", secrets: () => [ACCOUNT] })!;
  const session = await armRecorder(rp, { bindField: () => undefined, startsFresh: true, pageLog: recLog, log: () => {} });
  await rp.goto(LOC_URL);
  await sleep(2600);
  await rp.click("#next");
  await rp.waitForURL(/contacts/);
  await sleep(2600);
  session.stop();
  const rec = runLines("recorder-fixture").filter((l) => l.kind === "record" && l.status === "captured");
  check("two pages captured on their own (location, contacts)", rec.length === 2 && new Set(rec.map((l) => l.fp)).size === 2, JSON.stringify(rec));
  check("the person's click is still recorded", session.steps.some((s) => s.action === "click"), JSON.stringify(session.steps).slice(0, 300));
  await rctx.close();
} finally {
  await browser.close();
}

console.log("\n[F] a replay captures the pages it walks");
{
  const recipe = {
    id: "page-capture-replay", scopeType: "ahj", profileKey: "or||fernhollow-replay", state: "OR", ahj: "Fernhollow Replay", utility: "",
    portalPlatform: "fixture", portalUrl: `${base}/r/location`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps: [
      { action: "goto", value: `${base}/r/location`, note: "open the location step" } as RecipeStep,
      { action: "fill", selector: { css: "#search" }, value: "101 Fernhollow Way", note: "Search for location:" } as RecipeStep,
      { action: "click", selector: { css: "#next" }, note: "advance: NEXT STEP" } as RecipeStep,
      { action: "stopForReview" } as RecipeStep,
    ],
  } as PortalRecipe;
  const r = await stageWithRecipe(recipe, { id: "p-page-capture" } as ProjectRecord, { accountNumber: ACCOUNT }, {}, [], { headless: true } as never).catch((e: unknown) => ({ error: String(e) }));
  const lines = runLines("fernhollow-replay").filter((l) => l.kind === "replay");
  const caught = lines.filter((l) => l.status === "captured");
  check("the replay captured the page it left and the page it stopped on", caught.length === 2 && new Set(caught.map((l) => l.fp)).size === 2, JSON.stringify({ lines, r: JSON.stringify(r).slice(0, 300) }));
}

server.close();
console.log(failures === 0 ? `\nAll ${total}/${total} pageCapture DOM checks passed.` : `\n${failures}/${total} pageCapture DOM check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
