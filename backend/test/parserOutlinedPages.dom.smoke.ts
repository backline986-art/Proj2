// THE PARSER REVIEW NAMES PLAN PAGES WHOSE TEXT IS DRAWN AS OUTLINES (#696) — real Chromium, the
// real parser.html, an INVENTED plan set (_outlinedTextFixture.ts), and recorded plan-scan answers:
//   1. a text plan set: the plan-scan route answers 409 (the text parser reads it) with
//      details.outlinedTextPages [2] — the review flags "page 2 unread: text drawn as outlines; a
//      person reads this page" and says nothing was sent to any model;
//   2. a set with no usable text layer: the route answers its read with outlinedTextPages [1, 2, 3];
//      the flag names all three;
//   3. MUST-PASS (pinned): a 409 without the field adds no such flag.
// Discovered by scripts/run-dom-smokes.ts (*.dom.smoke.ts). Direct:
//   npx tsx backend/test/parserOutlinedPages.dom.smoke.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { REPO, ISOLATED_CWD } from "./_isolate";
import express from "express";
import { chromium } from "playwright";
import { outlinedPlanSet } from "./_outlinedTextFixture";

const app = express();
app.use(express.static(path.join(REPO, "frontend")));
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const tmp = path.join(ISOLATED_CWD, "docs");
fs.mkdirSync(tmp, { recursive: true });
const textSet = path.join(tmp, "text-with-outlined-page.pdf");
fs.writeFileSync(textSet, await outlinedPlanSet(["text", "outlined", "text", "text"]));
const outlinedSet = path.join(tmp, "all-outlined.pdf");
fs.writeFileSync(outlinedSet, await outlinedPlanSet(["outlined", "outlined", "outlined"]));

const EMPTY = { provider: "claude", fields: {}, lowConfidenceFields: [], notes: "" };
let failures = 0;
const check = (label: string, fn: () => void) => { try { fn(); console.log(`  ok   - ${label}`); } catch (e) { failures++; console.error(`  FAIL - ${label}: ${(e as Error).message}`); } };

const browser = await chromium.launch();
async function parse(planPath: string, planScan: { status: number; body: unknown }): Promise<{ flags: string; status: string; errors: string[]; calls: string[] }> {
  const page = await browser.newPage();
  const calls: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/api/parser/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    calls.push(url);
    if (url.endsWith("plan-scan-extract")) await route.fulfill({ status: planScan.status, contentType: "application/json", body: JSON.stringify(planScan.body) });
    else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(EMPTY) });
  });
  await page.addInitScript("window.__name = (fn) => fn;");
  await page.goto(`http://127.0.0.1:${port}/parser.html`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => Boolean((window as unknown as { pdfjsLib?: unknown }).pdfjsLib && (window as unknown as { ParserReview?: unknown }).ParserReview), null, { timeout: 60000 });
  await page.setInputFiles("#planFile", planPath);
  await page.click("#parseBtn");
  await page.waitForFunction(() => /All done|INCOMPLETE|Parse failed/.test(document.getElementById("parseStatus")!.textContent || ""), null, { timeout: 5 * 60 * 1000, polling: 500 });
  const out = await page.evaluate(() => ({
    flags: (document.getElementById("reviewFlags") as HTMLTextAreaElement | null)?.value ?? "",
    status: document.getElementById("parseStatus")!.textContent || "",
  }));
  await page.close();
  return { ...out, errors, calls };
}

try {
  const a = await parse(textSet, { status: 409, body: { error: "This plan set has a text layer", details: { outlinedTextPages: [2] } } });
  check("1. a text set: the plan-scan route was asked, then the text pass ran", () => {
    assert.ok(a.calls.some((c) => c.endsWith("plan-scan-extract")) && a.calls.some((c) => c.endsWith("llm-extract")), a.calls.join(","));
  });
  check("1. the 409's outlined page is flagged for a person", () => {
    assert.match(a.flags, /Plan-set page 2 unread: text drawn as outlines; a person reads this page\. Nothing on it was sent to any model/);
  });
  check("1. no page errors", () => assert.deepEqual(a.errors, []));

  const b = await parse(outlinedSet, { status: 200, body: { ...EMPTY, notes: "IMAGE-ONLY PLAN SET", visionFields: [], visionPages: [], planReadMode: "vision", outlinedTextPages: [1, 2, 3] } });
  check("2. a set with no usable text layer: its read's outlined pages are all flagged", () => {
    assert.match(b.flags, /Plan-set pages 1, 2, 3 unread: text drawn as outlines; a person reads this page\. Nothing on them was sent to any model/);
  });
  check("2. no page errors", () => assert.deepEqual(b.errors, []));

  const c = await parse(textSet, { status: 409, body: { error: "This plan set has a text layer", details: {} } });
  check("3. MUST-PASS (pinned): a 409 without outlined pages adds no such flag", () => {
    assert.doesNotMatch(c.flags, /text drawn as outlines/);
  });
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\nparserOutlinedPages.dom.smoke: ${failures} FAILED`); process.exit(1); }
console.log("\nparserOutlinedPages.dom.smoke: PASS");
