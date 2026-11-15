// A LABEL RECORDED ON A CLICK IS ALSO THE CONTROL'S ACCESSIBLE NAME (#193, #228).
//
// Live City of Tigard (Tyler EnerGov), 2026-11-15: the learner clicked the "Add Location" card
// through its stamped element and recorded the step as
//   { label: "Add\n                    Location\n ... REQUIRED\n An address is required." }
// with no other level. The card is a role="button" <div> whose text is those words; getByLabel
// never matches a button's content, so replay resolved nothing and the run stopped at step 6.
//
//   MUST PASS   the label-only click lands on the role=button card (and on a link named the same).
//   MUST KEEP   a label-only FILL still fills the <label for>-associated input (no twin for writes).
//   MUST EXCLUDE a label-only click whose words name no button or link still resolves nothing — it
//               is never handed to some other control.
//
// Run: npx tsx portal-bot/src/adapters/labelOnlyClick.dom.smoke.ts
import "../smokeArtifactDirs";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The EnerGov card, as captured: nested divs for the words, a footer with the REQUIRED hint, a
// click handler on the role=button wrapper that routes to the next view.
const PAGE = `<!doctype html><html><body>
  <h2>Apply for Permit</h2>
  <label for="desc">Description</label><input id="desc" type="text">
  <div id="card" role="button" tabindex="0" onclick="location.hash='#/location'; document.getElementById('hit').textContent='card';">
    <div class="card-body"><div>Add</div><div>Location</div><div class="row permit-plus-icon"><i class="fa fa-plus"></i></div></div>
    <div class="card-footer"><span>REQUIRED</span><div>An address is required.</div></div>
  </div>
  <a id="lnk" href="#/contacts" onclick="document.getElementById('hit').textContent='link';">Add Contact</a>
  <button id="decoy" type="button" onclick="document.getElementById('hit').textContent='decoy';">Continue</button>
  <div id="hit"></div>
</body></html>`;
const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const recipeOf = (steps: RecipeStep[]): PortalRecipe => ({
  id: "loc1", scopeType: "ahj", profileKey: "or|city of tigard|x", state: "OR", ahj: "City of Tigard", utility: "",
  portalPlatform: "energov", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);
const LABEL = "Add\n                    Location\n                    \n                \n                \n                    \n                        REQUIRED\n                        \n                        An address is required.";

const browser = await chromium.launch();
async function run(steps: RecipeStep[], values: Record<string, string> = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  await page.goto(url);
  const adapter = new RecipeAdapter(recipeOf(steps), values, {}, { autoSubmit: false, stallTimeoutMs: 45_000 });
  (adapter as unknown as { page: unknown }).page = page;
  const res = await adapter.fillApplication({} as never);
  const hit = await page.locator("#hit").textContent().catch(() => "");
  const desc = await page.locator("#desc").inputValue().catch(() => "");
  await ctx.close();
  return { res, hit: hit ?? "", desc };
}

try {
  // MUST PASS — the card.
  const a = await run([{ action: "click", phase: "fill", selector: { label: LABEL }, note: `advance: ${LABEL}` }, { action: "stopForReview" } as RecipeStep]);
  console.log(`  card: ok=${a.res.ok} hit=${a.hit} msg=${String(a.res.message ?? "").slice(0, 160)}`);
  check("MUST-PASS a label-only click lands on the role=button card whose words it recorded (Tigard \"Add Location\")", () => {
    assert.equal(a.hit, "card", `hit=${JSON.stringify(a.hit)}`);
    assert.equal(a.res.ok, true, String(a.res.message ?? "").slice(0, 200));
  });
  // MUST PASS — a link named the same way.
  const b = await run([{ action: "click", phase: "fill", selector: { label: "Add\n   Contact" }, note: "advance: Add Contact" }, { action: "stopForReview" } as RecipeStep]);
  check("MUST-PASS ...and on a link named by those words", () => { assert.equal(b.hit, "link", `hit=${JSON.stringify(b.hit)}`); });
  // MUST KEEP — a write keeps its label.
  const c = await run([{ action: "fill", phase: "fill", selector: { label: "Description" }, field: "workDescription", note: "Description" }, { action: "stopForReview" } as RecipeStep], { workDescription: "Roof PV" });
  check("MUST-KEEP a label-only FILL still fills its <label for> input", () => { assert.equal(c.desc, "Roof PV"); assert.equal(c.hit, ""); });
  // MUST EXCLUDE — words that name no button or link.
  const d = await run([{ action: "click", phase: "fill", selector: { label: "Add\n  Parcel" }, note: "advance: Add Parcel" }, { action: "stopForReview" } as RecipeStep]);
  check("MUST-EXCLUDE a label-only click naming no button or link clicks nothing else (not the decoy Continue)", () => {
    assert.equal(d.hit, "", `hit=${JSON.stringify(d.hit)}`);
    assert.equal(d.res.ok, false);
  });
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\nlabelOnlyClick.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nlabelOnlyClick.dom.smoke: PASS");
process.exit(0);
