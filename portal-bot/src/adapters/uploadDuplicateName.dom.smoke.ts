// #224 — ONE FILE INTO TWO NAMED SLOTS ON ONE PAGE: the second upload carries the slot's own name, so
// a portal that refuses a repeated file name ("File already exists", live City of Tigard EnerGov
// Attachments, 2026-11-13/14) takes both. SYNTHETIC replica, synthetic file.
//
//   MUST-PASS  combined mode, slots "Electrical Line Diagram Plans" and "Plan Set" (required): both
//              take the plan set; the page records two DISTINCT names; the second names its slot;
//              no "File already exists" banner.
//   MUST-KEEP  the first upload keeps the file's own clean name.
//
// Run: npx tsx portal-bot/src/adapters/uploadDuplicateName.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dupname-"));
const planSet = path.join(dir, "demo-test-plan-set.pdf");
fs.writeFileSync(planSet, "%PDF-1.4\n% synthetic test plan set\n%%EOF\n");

const page = `<!doctype html><html><head><title>Apply for Permit</title></head><body>
<h3>Attachments</h3>
<div id="banner"></div>
<div class="card"><h4>Electrical Line Diagram Plans</h4><span>Add Attachment</span> <input type="file" id="eld" accept=".pdf" aria-label="Attachment Electrical Line Diagram"></div>
<div class="card"><h4>Plan Set</h4><span>Add Attachment</span> <input type="file" id="ps" accept=".pdf" aria-label="Attachment Plan Set" required><div>REQUIRED</div></div>
<button type="button" id="next">Next</button>
<script>
window.__names = [];
document.querySelectorAll("input[type=file]").forEach(function (inp) {
  inp.addEventListener("change", function () {
    var f = inp.files && inp.files[0]; if (!f) return;
    if (window.__names.indexOf(f.name) >= 0) {
      document.getElementById("banner").textContent = "File already exists: " + f.name;
      inp.value = ""; return;
    }
    window.__names.push(f.name);
  });
});
</script></body></html>`;

const planner: LearnPlanner = async () => ({ fills: [], atReview: false });
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const pg = await ctx.newPage();
  await pg.setContent(page);
  const adapter = new AutoLearnAdapter("Dup Name Smoke", planner, { uploadMode: "combined", docsByType: { plan_set: planSet } });
  (adapter as unknown as { page: unknown }).page = pg;
  const events: Array<Record<string, unknown>> = [];
  const noop = async (): Promise<void> => undefined;
  (adapter as unknown as { debug: unknown }).debug = { event: (e: Record<string, unknown>) => { events.push(e); }, writeJson: () => undefined, capturePageHtml: noop, screenshot: noop, startTrace: noop, stopTrace: noop, finalize: noop, setScrubber: () => undefined, dir: "" };
  const out = await (adapter as unknown as { performUploads(s: unknown[], f: string[], o?: unknown): Promise<{ attached: number; missingRequired: string[] }> }).performUploads([], []);
  const names = await pg.evaluate(() => (window as unknown as { __names: string[] }).__names);
  const banner = (await pg.locator("#banner").textContent()) ?? "";
  const detail = `names=${JSON.stringify(names)} banner=${JSON.stringify(banner)} attached=${out.attached} missing=${JSON.stringify(out.missingRequired)}`;
  console.log(`# ${detail}`);
  console.log(`#   events: ${JSON.stringify(events.map((e) => ({ ...e, t: undefined, ms: undefined }))).slice(0, 1500)}`);
  check("MUST-PASS both slots took the plan set under two distinct names, no duplicate refusal", names.length === 2 && new Set(names).size === 2 && !/already exists/i.test(banner), detail);
  check("MUST-KEEP the first upload keeps the file's own name; the second names its slot",
    names[0] === "demo-test-plan-set.pdf" && /^demo-test-plan-set - (Plan Set|Electrical Line Diagram Plans)\.pdf$/.test(names[1] ?? ""), detail);
  await ctx.close();
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "uploadDuplicateName.dom.smoke: PASS" : `uploadDuplicateName.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
