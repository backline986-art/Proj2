// A CONTROL THE LEARN SAW ONLY AFTER A REVEAL IS RECORDED CONDITIONAL, AND REPLAY SKIPS IT WHERE
// THIS JOB'S ANSWERS DO NOT REVEAL IT (#237 (4)), IN REAL CHROMIUM.
//
// The 2026-11-14 recipe audit: PacifiCorp 32f3d2b2 102/111/112 are battery-inverter controls the
// learn saw only in a reveal and that a later tick hides (run-fatal on battery jobs); Ameren
// 07370f52 25 "County" renders only once the facility address resolves (ten historical misses).
// The learner's post-fill re-scan already knew which controls APPEARED (its revealed_controls
// event); nothing recorded it on the step, so the replay treated them as mandatory.
//
// MUST-PASS: the learn marks the step it records on the revealed box `conditional`; a replay of the
//   learned steps on a portal whose answer reveals nothing skips that step, named, and still fills
//   what follows and reaches the review stop. Both again with PowerClerk's generic test hook on every
//   box, which the learner records as a fallback that matches the other boxes (review of #237).
// MUST-EXCLUDE: the controls present at entry (the choice, the rating) are never marked; a replay
//   on the revealing portal still FILLS the conditional box (shown is always written).
//
// Run: npx tsx portal-bot/src/adapters/revealConditional.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Browser } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const REVEALED = "Existing Transformer Number";
// `hooks`: PowerClerk's shape — every box carries the platform's generic test hook, so the learner
// records `[data-test-role="textbox-element"]` as a fallback on each step, and that hook matches the
// OTHER visible boxes when the revealed one is not there (review of #237: the conditional skip never
// fired on PowerClerk).
const page = (reveal: boolean, hooks: boolean): string => {
  const box = hooks ? ` data-test-role="textbox-element"` : "";
  const list = hooks ? ` data-test-role="dropdownlist-element"` : "";
  return `<!doctype html><html><head><title>Edit Project</title></head><body>
<div id="step1">
  <h2>Service Details</h2>
  <div class="form-group"><label for="kind">Service type</label>
    <select id="kind"${list}><option value="">-- Select --</option><option>New service</option><option>Existing service</option></select></div>
  <div id="reveal"></div>
  <div class="form-group"><label for="amps">Main Service Entrance Rating (Amps)</label><input id="amps" type="text"${box}></div>
  <button id="next" type="button">Next</button>
</div>
<div id="step2" style="display:none">
  <h2>Review</h2>
  <p>Please review your application before submitting.</p>
  <button id="submit" type="button">Submit Application</button>
</div>
<script>
  // The dependent box is RENDERED only after the choice's own round-trip (a Vue v-if): before it,
  // it does not exist. The no-reveal portal answers the same choice with nothing.
  document.getElementById('kind').addEventListener('change', function () {
    ${reveal ? `var v = this.value;
    setTimeout(function () {
      var host = document.getElementById('reveal');
      host.innerHTML = v === 'Existing service'
        ? '<div class="form-group"><label for="xfmr">${REVEALED}</label><input id="xfmr" type="text"${box}></div>' : '';
    }, 300);` : ""}
  });
  document.getElementById('next').addEventListener('click', function () {
    document.getElementById('step1').remove();
    document.getElementById('step2').style.display = 'block';
  });
</script>
</body></html>`;
};

const server = http.createServer((req, res) => {
  const url = String(req.url || "");
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page(!url.replace(/^\/hooks(?=\/)/, "").startsWith("/noreveal"), url.startsWith("/hooks/")));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// The planner: the choice and the rating on the page's first look; the revealed box on the re-scan;
// review when the page says review.
const planner: LearnPlanner = async (req) => {
  if (/please review/i.test(req.bodyText)) return { fills: [], atReview: true };
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(f.label));
  const advanceSelectorIndex = next >= 0 ? next : undefined;
  const at = (label: string) => req.fields.findIndex((f) => f.label === label && !req.alreadyFilledLabels.includes(label));
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  if (at("Service type") >= 0) fills.push({ selectorIndex: at("Service type"), value: "Existing service" });
  if (at("Main Service Entrance Rating (Amps)") >= 0) fills.push({ selectorIndex: at("Main Service Entrance Rating (Amps)"), value: "200", field: "mainServiceRating" });
  if (at(REVEALED) >= 0) fills.push({ selectorIndex: at(REVEALED), value: "TX-4471", field: "utilityTransformerNumber" });
  return { fills, advanceSelectorIndex, atReview: false };
};

const browser: Browser = await chromium.launch();
try {
  for (const pre of ["", "/hooks"]) {
  const tag = pre ? " [generic test hooks]" : "";
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const lp = await ctx.newPage();
  await lp.goto(`${base}${pre}/app`);
  const learner = new AutoLearnAdapter("Example Utility (reveal-conditional smoke)", planner, { policyProfile: "none" });
  (learner as unknown as { page: unknown }).page = lp;
  const learned = await learner.learn({} as never, { mainServiceRating: "200", utilityTransformerNumber: "TX-4471" } as unknown as ProjectRecord);
  await ctx.close();
  const steps = learned.steps;
  const brief = steps.map((s) => `${s.action}:${String(s.note ?? "").slice(0, 40)}${s.conditional ? " [conditional]" : ""}`).join(" | ");
  console.log(`   learned${tag} (${learned.reachedReview ? "reached review" : "no review"}): ${brief}`);
  const of = (label: string): RecipeStep | undefined => steps.find((s) => String(s.note ?? "").includes(label) || s.selector?.label === label);

  check(`the learn reaches review and records the revealed box${tag}`, learned.reachedReview === true && !!of(REVEALED), brief);
  check(`MUST-PASS the step on the revealed box is marked conditional${tag}`, of(REVEALED)?.conditional === true, brief);
  check(`MUST-EXCLUDE the controls present at entry are never marked${tag}`, !of("Service type")?.conditional && !of("Main Service Entrance Rating")?.conditional, brief);
  if (pre) {
    const sel = of(REVEALED)?.selector;
    check(`${tag.trim()} the learner recorded the generic hook as a fallback on the revealed box (the shape under test)`,
      [sel, ...(sel?.fallbacks ?? [])].some((l) => l?.css === "[data-test-role=\"textbox-element\"]"), JSON.stringify(sel));
  }

  const replay = async (path: string): Promise<{ ok: boolean; message: string; aging: string[]; values: Record<string, string>; reachedReview: boolean }> => {
    const recipe = {
      id: "reveal-conditional", scopeType: "utility", profileKey: "xx||example", state: "OR", ahj: "", utility: "Example Utility",
      portalPlatform: "fixture", portalUrl: `${base}${path}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "", discipline: "",
      steps: [{ action: "goto", value: `${base}${path}`, note: "open" } as RecipeStep, ...steps.filter((s) => s.action !== "goto" && !s.isFinalSubmit)],
    } as unknown as PortalRecipe;
    const rc = await browser.newContext();
    await rc.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
    const rp = await rc.newPage();
    const adapter = new RecipeAdapter(recipe, { mainServiceRating: "200", utilityTransformerNumber: "TX-9902" }, {}, { autoSubmit: false });
    (adapter as unknown as { page: unknown }).page = rp;
    const values: Record<string, string> = {};
    // The boxes are gone once the review step renders: read them as the run leaves the page.
    await rp.exposeFunction("__seen", (id: string, v: string) => { values[id] = v; }).catch(() => null);
    await rc.addInitScript(() => {
      document.addEventListener("click", (e) => {
        if ((e.target as HTMLElement)?.id !== "next") return;
        for (const el of Array.from(document.querySelectorAll("input, select"))) (window as unknown as { __seen: (a: string, b: string) => void }).__seen(el.id, (el as HTMLInputElement).value);
      }, true);
    });
    const r = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e) })) as { ok: boolean; message?: string; data?: Record<string, unknown> };
    const reachedReview = await rp.locator("#step2").isVisible().catch(() => false);
    await rc.close();
    return { ok: r.ok === true, message: String(r.message ?? ""), aging: ((r.data ?? {}).agingNotes as string[]) ?? [], values, reachedReview };
  };

  const none = await replay(`${pre}/noreveal`);
  console.log(`   replay ${pre}/noreveal: ok=${none.ok} review=${none.reachedReview} msg=${none.message.slice(0, 160)} values=${JSON.stringify(none.values)} aging=${JSON.stringify(none.aging).slice(0, 300)}`);
  check(`MUST-PASS on a portal whose answer reveals nothing, the conditional step is skipped, named${tag}`,
    none.aging.some((n) => n.includes(REVEALED) && /reveal/i.test(n) && /#237/.test(n)), JSON.stringify(none.aging));
  check(`MUST-PASS ...and the run still fills what follows and reaches the review stop${tag}`, none.ok && none.reachedReview && none.values.amps === "200", `ok=${none.ok} review=${none.reachedReview} ${none.message.slice(0, 200)} ${JSON.stringify(none.values)}`);

  const shown = await replay(`${pre}/app`);
  console.log(`   replay ${pre}/app: ok=${shown.ok} review=${shown.reachedReview} values=${JSON.stringify(shown.values)}`);
  check(`MUST-EXCLUDE on the revealing portal the conditional box is still FILLED with this job's value${tag}`, shown.ok && shown.values.xfmr === "TX-9902" && !shown.aging.some((n) => /#237/.test(n)), `${shown.message.slice(0, 200)} ${JSON.stringify(shown.values)} ${JSON.stringify(shown.aging).slice(0, 200)}`);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} reveal-conditional check(s) FAILED.`); process.exit(1); }
console.log("\nAll reveal-conditional checks passed (real Chromium).");
process.exit(0);
