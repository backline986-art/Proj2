// A LABEL RE-ANCHOR TAKES THE BOX WHOSE LABEL IS THE WHOLE RECORDED LABEL, NOT ONE THAT SHARES A WORD.
//
// reanchorIfWrongControl compares labels by their STRONG words (stopwords dropped: "name",
// "number", "type"), so a recorded "Business Name" is {business}. On a page that also holds
// "Business Phone", both candidates scored one word; the visible one — or simply the first in
// the document — won, and the step was re-anchored onto the phone box. Live City of Tigard
// (Tyler EnerGov SelfService) contact lookup, replay v8 of 2026-11-15: the recorded fallback
// `input[id*='Name' i]` resolved onto First Name, the mismatch was caught, and the re-anchor then
// chose #BusinessPhone — "step "Business Name" resolved onto "First Name" — re-anchored by label
// to #BusinessPhone" — where the company name's fill timed out.
//
// The rule: every word of the recorded label (stopwords included, requirement markers dropped)
// counts, the whole phrase ranks first, and a strong word of the candidate's own that the
// recorded label never had ("phone") counts against it. The strong-word gate is unchanged.
//
// Synthetic page and names. Run: npx tsx portal-bot/src/adapters/reanchorWholeLabel.dom.smoke.ts
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

// First Name comes first (so a `[id*='Name']` fallback lands on it), the phone box BEFORE the
// name box (so a tie on {business} falls to the phone, as it did live). The name box's label is
// not the recorded words verbatim, so the label level misses it and the fallback runs.
const PAGE = `<!doctype html><html><body>
  <h2 id="heading">Add Contact As : Contractor</h2>
  <label for="FirstName">First Name</label><input id="FirstName" type="text">
  <label for="LastName">Last Name</label><input id="LastName" type="text">
  <label for="BusinessPhone">Business Phone</label><input id="BusinessPhone" type="text">
  <label for="BusinessName">Business/Company Name</label><input id="BusinessName" type="text">
  <button id="search" type="button">Search</button>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "rwl1", scopeType: "ahj", profileKey: "zz||maplecrest", state: "ZZ", ahj: "City of Maplecrest", utility: "",
  portalPlatform: "energov", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const LOOKUP_FALLBACK = "input[id*='Business' i], input[id*='Company' i], input[id*='Name' i]";

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE A — the live shape: recorded "Business Name", fallback lands on First Name.
const pA = await context.newPage();
await pA.goto(url);
const aA = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "installerCompanyName", note: "lookup(Add Contact As : Contractor): business name",
    selector: { label: "Business Name", fallbacks: [{ css: LOOKUP_FALLBACK }] },
  } as RecipeStep,
]), { installerCompanyName: "Quillfeather Solar LLC" }, {}, { autoSubmit: false });
(aA as unknown as { page: unknown }).page = pA;
await aA.fillApplication({} as never);
const nameA = await pA.locator("#BusinessName").inputValue();
const phoneA = await pA.locator("#BusinessPhone").inputValue();
const firstA = await pA.locator("#FirstName").inputValue();
// The re-anchor's note is a drift warning on the adapter (the fill result carries them under its
// own shape; the adapter's list is the one the live replay json printed).
const notesA = ((aA as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");

check("MUST-PASS: the company name lands in the box whose label is the whole recorded label", () => {
  assert.equal(nameA, "Quillfeather Solar LLC", `#BusinessName holds ${JSON.stringify(nameA)}`);
});
check("MUST-PASS: the box that merely shares a word (\"Business Phone\") is left empty", () => {
  assert.equal(phoneA, "", `#BusinessPhone received ${JSON.stringify(phoneA)} — the live v8 failure`);
});
check("MUST-PASS: the box the fallback resolved onto (First Name) is left empty", () => {
  assert.equal(firstA, "", `#FirstName received ${JSON.stringify(firstA)}`);
});
check("the re-anchor is named, to the name box", () => {
  assert.match(notesA, /resolved onto "First Name" — re-anchored by label to #BusinessName/, notesA.slice(0, 400));
});

// CASE B — MUST-KEEP, the mirror: recorded "Business Phone" re-anchors to the phone box, never the
// name box (two strong words, and the name box has only one of them).
const pB = await context.newPage();
await pB.goto(url);
const aB = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "installerPhone", note: "lookup(Add Contact As : Contractor): business phone",
    selector: { label: "Business Telephone", fallbacks: [{ css: "input[id*='Name' i], input[id*='Business' i]" }] },
  } as RecipeStep,
]), { installerPhone: "503-555-0100" }, {}, { autoSubmit: false });
(aB as unknown as { page: unknown }).page = pB;
await aB.fillApplication({} as never);
const phoneB = await pB.locator("#BusinessPhone").inputValue();
const nameB = await pB.locator("#BusinessName").inputValue();

check("MUST-KEEP: the name box never receives the phone number", () => {
  assert.equal(nameB, "", `#BusinessName received ${JSON.stringify(nameB)} — a phone number in the company name`);
});
check("MUST-KEEP: a recorded phone label heals to the phone box or is skipped, named — never written elsewhere", () => {
  // "Business Telephone" vs the page's "Business Phone": strong words {business, telephone}; the gate
  // wants two of them, and "phone" is a subsequence of "telephone" only in the agree() escape, not in
  // the candidate scan — so today this heals to the phone box or skips; this pins that it never
  // lands anywhere else.
  assert.ok(phoneB === "503-555-0100" || phoneB === "", `#BusinessPhone holds ${JSON.stringify(phoneB)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} reanchor-whole-label smoke check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll reanchor-whole-label smoke checks passed (real Chromium).");
process.exit(0);
