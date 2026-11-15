// A RECORDED ANSWER NOTHING BOUND IS THE LEARN JOB'S ANSWER (#236).
//
// The 2026-11-14 audit of all 22 saved recipes found recorded values with no binding replaying on
// every job. This smoke drives the real chain on a real page: resolveRecipeFieldValues (the project's
// keys) -> bindRecipeForReplay (the backend binder every replay runs) -> RecipeAdapter, in Chromium.
//
//   E4  A split address search (Accela's work location): the recipe recorded Direction "NW" and
//       Street Type "ST" (the learn job's address). Replayed for an "SE ... Ave" project the search
//       must ask SE ... AVE; for a directionless "... Way" project the Direction stays unanswered and
//       the type is WAY. On main both projects searched NW ... ST.
//   E4b The same search on a portal that lists WORDS ("Street", "Avenue"): the recorded "Street"
//       binds to the word form, so the "SE ... Ave" project gets "Avenue" — never "Crest", which a
//       contains match on "ST" would pick.
//   R1  A storage radio whose question lives only in the step's section (Ameren's shape: a check on
//       the radio labelled "No"): ticked on a job without a battery, left for a person, named, on a
//       job with one. On main the learn job's "No" was ticked on the battery job.
//   H1  An unbound select replayed as recorded is named on the hand-off ("replayed the learn's
//       answer"), and a bound one is not.
//
// Synthetic pages and projects only. Run: npx tsx portal-bot/src/adapters/unboundLearnLiterals.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "unbound-literals-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");

const { openDatabase } = await import("../../../backend/src/db");
const { resolveRecipeFieldValues } = await import("../../../backend/src/portalRecipes");
const { bindRecipeForReplay } = await import("../../../backend/src/recipeReplayBinding");
const { RecipeAdapter } = await import("./recipeAdapter");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const opts = (xs: string[]): string => `<option value="">--Select--</option>${xs.map((x) => `<option>${x}</option>`).join("")}`;
const SEARCH = (types: string[], dirs: string[]): string => `<!doctype html><html><body>
  <h2>Work Location</h2>
  <label for="no">Street No.:</label> <input id="no">
  <label for="dir">Direction:</label> <select id="dir">${opts(dirs)}</select>
  <label for="name">Street Name:</label> <input id="name">
  <label for="type">Street Type:</label> <select id="type">${opts(types)}</select>
  <h2>Details</h2>
  <label for="ctype">Customer Type:</label> <select id="ctype">${opts(["Commercial", "Residential"])}</select>
  <label for="st">State:</label> <select id="st">${opts(["OR", "WA"])}</select>
</body></html>`;
const RADIO = `<!doctype html><html><body>
  <fieldset><legend>Do you seek to install an Energy Storage System (ESS), or batteries as part of this project?</legend>
    <label><input type="radio" name="ess" id="essYes" value="Y"> Yes</label>
    <label><input type="radio" name="ess" id="essNo" value="N"> No</label>
  </fieldset>
</body></html>`;
const PAGES: Record<string, string> = {
  "/abbr": SEARCH(["AVE", "CREST", "DR", "ST", "WAY"], ["N", "NE", "NW", "S", "SE", "SW", "E", "W"]),
  "/words": SEARCH(["Alley", "Avenue", "Crest", "Drive", "Street", "Way"], ["North", "Northeast", "Northwest", "South", "Southeast", "Southwest", "East", "West"]),
  "/radio": RADIO,
};
const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGES[String(q.url)] ?? "<p>not found</p>"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const db = await openDatabase();
const projectAt = (projectAddress: string, snapshot: Record<string, unknown> = {}): ProjectRecord => ({
  id: "p-unbound", clientId: null, homeownerName: "ZZ Test Owner", projectAddress, city: "Testville", state: "OR", zip: "97000",
  ahj: "City of Testville", utility: "Test Power", parserSnapshot: snapshot,
} as unknown as ProjectRecord);

const recipeOf = (steps: RecipeStep[], url: string): PortalRecipe => ({
  id: "rcp-unbound", scopeType: "ahj", profileKey: "or|city of testville", state: "OR", ahj: "City of Testville", utility: "",
  portalPlatform: "accela", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "electrical",
} as unknown as PortalRecipe);

// What a learn on another address leaves behind (the Corvallis shape, synthetic values): the number
// and name bound, the direction and the type frozen as the learn job's literals.
const searchSteps = (dir: string, type: string): RecipeStep[] => [
  { action: "fill", phase: "fill", selector: { css: "#no", label: "Street No.:" }, field: "streetNumber", note: "Street No.:" },
  { action: "select", phase: "fill", selector: { css: "#dir", label: "Direction:" }, value: dir, note: "Direction:" },
  { action: "fill", phase: "fill", selector: { css: "#name", label: "Street Name:" }, field: "streetNameCore", note: "Street Name:" },
  { action: "select", phase: "fill", selector: { css: "#type", label: "Street Type:" }, value: type, note: "Street Type:" },
  { action: "select", phase: "fill", selector: { css: "#ctype", label: "Customer Type:" }, value: "Residential", note: "Customer Type:" },
  { action: "select", phase: "fill", selector: { css: "#st", label: "State:" }, field: "state", note: "State:" },
] as RecipeStep[];

async function replay(recipe: PortalRecipe, project: ProjectRecord, read: string[]): Promise<{ values: Record<string, string>; drift: string[]; aging: string[]; changes: string[] }> {
  const fieldValues = resolveRecipeFieldValues(db, project, "accela", "permit");
  const binding = bindRecipeForReplay({
    steps: recipe.steps, portalUrl: recipe.portalUrl, project: { ...project, city: project.city } as never,
    fieldValues, track: "permit", borrowed: null, agency: null,
  });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(recipe.portalUrl);
  const a = new RecipeAdapter({ ...recipe, steps: binding.steps }, { ...fieldValues, ...binding.fieldValues }, {}, { autoSubmit: false });
  (a as unknown as { page: unknown }).page = page;
  await a.fillApplication(project).catch((e: unknown) => console.log(`   (run ended: ${String((e as Error)?.message ?? e).slice(0, 120)})`));
  const values: Record<string, string> = {};
  for (const sel of read) {
    values[sel] = await page.locator(sel).evaluate((el) => (el instanceof HTMLInputElement && el.type === "radio")
      ? (el.checked ? "checked" : "") : (el as HTMLInputElement | HTMLSelectElement).value).catch(() => "?");
  }
  const priv = a as unknown as { driftWarnings: string[]; agingNotes: string[] };
  await browser.close();
  return { values, drift: [...priv.driftWarnings], aging: [...priv.agingNotes], changes: binding.changes.map((c) => `${c.kind}: ${c.reason}`) };
}

// ── E4: the learn job's NW ... ST must not search an SE ... Ave project ──────────────────────────
const se = await replay(recipeOf(searchSteps("NW", "ST"), `${base}/abbr`), projectAt("1234 SE Example Ave, Testville, OR 97000"), ["#no", "#dir", "#name", "#type"]);
console.log(`   SE ... Ave project -> ${JSON.stringify(se.values)}`);
check("E4: the street number and name are this project's (bound before #236 too)",
  se.values["#no"] === "1234" && /^exa/i.test(se.values["#name"]), JSON.stringify(se.values));
check("E4: Direction is this project's SE, not the learn job's NW",
  se.values["#dir"] === "SE", `Direction=${JSON.stringify(se.values["#dir"])} — the search would look up another address`);
check("E4: Street Type is this project's AVE, not the learn job's ST",
  se.values["#type"] === "AVE", `Street Type=${JSON.stringify(se.values["#type"])}`);

const way = await replay(recipeOf(searchSteps("NW", "ST"), `${base}/abbr`), projectAt("500 Larkspur Way, Testville, OR 97000"), ["#dir", "#type"]);
console.log(`   directionless ... Way project -> ${JSON.stringify(way.values)}`);
check("E4: a directionless address leaves Direction unanswered — no direction is the answer, never NW",
  way.values["#dir"] === "", `Direction=${JSON.stringify(way.values["#dir"])}`);
check("E4: ...and its type is WAY", way.values["#type"] === "WAY", `Street Type=${JSON.stringify(way.values["#type"])}`);
check("E4: the binder names why the Direction step was not replayed",
  way.changes.some((c) => /^stripped: .*no street direction/.test(c)), JSON.stringify(way.changes));

// ── E4b: a portal listing words keeps its own vocabulary ────────────────────────────────────────
const words = await replay(recipeOf(searchSteps("Northwest", "Street"), `${base}/words`), projectAt("1234 SE Example Ave, Testville, OR 97000"), ["#dir", "#type"]);
console.log(`   word-vocabulary portal -> ${JSON.stringify(words.values)}`);
check("E4b: a recorded word answers in words — Southeast / Avenue, never \"Crest\" by a contains match",
  words.values["#dir"] === "Southeast" && words.values["#type"] === "Avenue", JSON.stringify(words.values));

// ── H1: the hand-off names the unbound answer it replayed ───────────────────────────────────────
check("H1: the unbound select replayed as recorded is named on the hand-off",
  se.aging.some((n) => /^replayed the learn's answer: "Customer Type:" = "Residential"/.test(n)), JSON.stringify(se.aging));
check("H1: a bound select (State) and the bound address components are not",
  !se.aging.some((n) => /^replayed the learn's answer: "(State:|Direction:|Street Type:)"/.test(n)), JSON.stringify(se.aging));

// ── R1: the storage radio whose question is only its section ────────────────────────────────────
const radioSteps = [
  { action: "check", phase: "fill", selector: { css: "#essNo", label: "No" }, note: "No",
    fingerprint: { section: "Do you seek to install an Energy Storage System (ESS), or batteries as part of t" } },
] as RecipeStep[];
const noBattery = await replay(recipeOf(radioSteps, `${base}/radio`), projectAt("1234 SE Example Ave", { hasBattery: "No" }), ["#essYes", "#essNo"]);
console.log(`   recorded "No", no-battery job -> ${JSON.stringify(noBattery.values)}`);
check("R1: on a job without a battery the recorded No is ticked (it is this job's answer)",
  noBattery.values["#essNo"] === "checked" && noBattery.values["#essYes"] === "", JSON.stringify(noBattery.values));
const withBattery = await replay(recipeOf(radioSteps, `${base}/radio`), projectAt("1234 SE Example Ave", { hasBattery: "Yes", batteryModel: "Test Battery 10" }), ["#essYes", "#essNo"]);
console.log(`   recorded "No", battery job -> ${JSON.stringify(withBattery.values)} drift=${JSON.stringify(withBattery.drift)}`);
check("R1: on a job WITH a battery the learn job's No is not ticked",
  withBattery.values["#essNo"] === "", `No=${JSON.stringify(withBattery.values["#essNo"])} — the utility would be told there is no storage`);
check("R1: ...nor is Yes chosen by position (the recipe never recorded that control)",
  withBattery.values["#essYes"] === "", JSON.stringify(withBattery.values));
check("R1: ...and the question is named for a person",
  withBattery.drift.some((d) => /^left "Do you seek to install an Energy Storage System.*for a person/.test(d)), JSON.stringify(withBattery.drift));

server.close();
try { (db as unknown as { close?: () => void }).close?.(); } catch { /* the scratch DB is ours */ }
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment; it is a temp folder */ }
if (failures) { console.error(`\n${failures} unbound-learn-literal check(s) FAILED.`); process.exit(1); }
console.log("\nunbound learn literals: every check passed.");
process.exit(0);
