// THE STAMPED DRAFT CLICK READS THE REQUIRED FIELDS ONCE MORE, LAST THING BEFORE THE CLICK (#120).
//
// The CI-run twin of draftSubmitPins.dom.smoke's advRerender checks (which need a real Chromium).
// The ready check in front of the stamped draft-creating Submit takes real time, and a portal that
// re-renders a section late can blank a required value AFTER the required-field read passed. The
// click then landed on a form the browser refuses to send: nothing posted, the page after it "not a
// draft", the run ended as an incident and the stamp was deleted, for a click that sent nothing.
// (#120 read this as the recorded-literal guard blanking the value. That guard leaves an unrelated,
// optional field blank on the passing run too; the timing of the re-render decides the outcome.)
//
// Pinned here, on an adapter whose page-facing helpers are doubles that record their order:
//   - a page that stays ready: one ready check, the last read, ONE click — as before;
//   - a required field blanked after the ready check: the WHOLE ready check runs again (re-assert,
//     gap-fill, picks-in-front, required, the control's label, the drain — never fewer), then ONE click;
//   - MUST-STOP: a field that is blank again after the second check is a refusal — nothing clicked,
//     a review stop, never an incident;
//   - MUST-STOP: the second check's own stops still stop (a pick in front, a control that no longer
//     reads as the stamped one): the repair never skips a guard;
//   - the gate (draftCreatingClickRefusals) is asked before any of it, exactly as before.
//
//   npx tsx portal-bot/src/adapters/draftSubmitReadyAtClick.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { draftTenantKey, type DraftCreatingStamp } from "../draftSubmitGate";

let failures = 0;
const check = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const URL_NOW = "http://127.0.0.1/m/unit/part1";
const DRAFT_PAGE = "Your draft application NEM-90017 has been created. Continue to Interconnection Application - Part 2 to complete your interconnection application and submit.";
const submit = { action: "click", selector: { css: "#btnSubmit", text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)" } as unknown as RecipeStep;
const recipe = {
  id: "draft-ready-unit", scopeType: "utility", profileKey: "wa||twopart", state: "WA", ahj: "", utility: "Two-Part Utility",
  portalPlatform: "fixture", portalUrl: URL_NOW, status: "complete", version: 1, createdBy: "test", createdAt: "", updatedAt: "", notes: "",
  steps: [{ action: "stopForReview" } as unknown as RecipeStep, submit],
} as PortalRecipe;
const stamp: DraftCreatingStamp = { stepIndex: 1, tenantKey: draftTenantKey(URL_NOW), label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" };

type Out = { kind: string; refusals?: string[]; incident?: unknown };
/**
 * Drive clickDraftCreatingSubmit with the page-facing helpers replaced by doubles.
 * `required`: what each successive required-field read returns (the last entry repeats).
 * `picks` / `labels`: the same, for the picks-in-front read and the control's own label.
 */
async function drive(script: { required: string[][]; picks?: string[][]; labels?: string[] }) {
  const adapter = new RecipeAdapter(recipe, {}, {}, { draftSubmitStamp: stamp });
  const calls: string[] = [];
  const next = <T>(list: T[], seen: number): T => list[Math.min(seen, list.length - 1)];
  let requiredReads = 0;
  let pickReads = 0;
  let labelReads = 0;
  const a = adapter as unknown as Record<string, unknown>;
  a.page = {
    url: () => URL_NOW,
    frames: () => [],
    mainFrame: () => null,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    locator: () => ({ innerText: async () => DRAFT_PAGE, count: async () => 0, first() { return this; } }),
    getByText: () => ({ count: async () => 0, isVisible: async () => false, first() { return this; } }),
  };
  a.reassertBlanksOnce = async () => { calls.push("reassert"); return []; };
  a.runGapFill = async () => { calls.push("gapfill"); return null; };
  a.pageIdentity = async () => "page-1";
  a.unrecordedPicksInFront = async () => { calls.push("picks"); return next(script.picks ?? [[]], pickReads++); };
  a.emptyRequiredControls = async () => { calls.push("required"); return next(script.required, requiredReads++); };
  a.resolveLocator = async () => ({ the: "stamped control" });
  a.narrowToOne = async (loc: unknown) => loc;
  a.controlLabelOf = async () => { calls.push("label"); return next(script.labels ?? ["Submit"], labelReads++); };
  a.drainBeforeReviewLock = async () => { calls.push("drain"); };
  a.guardedClick = async () => { calls.push("CLICK"); };
  a.capturePageShot = async () => null;
  const out = await (a.clickDraftCreatingSubmit as (i: number) => Promise<Out>).call(adapter, 1);
  return { out, calls, clicks: calls.filter((c) => c === "CLICK").length };
}
const READY = ["reassert", "gapfill", "picks", "required", "label", "drain"];

await check("a page that stays ready: one ready check, the last required read, one click — the draft", async () => {
  const r = await drive({ required: [[]] });
  assert.deepEqual(r.calls, [...READY, "required", "CLICK"], JSON.stringify(r.calls));
  assert.equal(r.out.kind, "draft", JSON.stringify(r.out));
});

await check("a required field blanked AFTER the ready check: the whole ready check runs again, then one click — the draft, never an incident", async () => {
  // read 1 (ready check) clean; read 2 (last thing before the click) finds it blank; the second
  // ready check's re-assert repairs it, so reads 3 and 4 are clean.
  const r = await drive({ required: [[], ["Application Date"], [], []] });
  assert.deepEqual(r.calls, [...READY, "required", ...READY, "required", "CLICK"], JSON.stringify(r.calls));
  assert.equal(r.clicks, 1);
  assert.equal(r.out.kind, "draft", JSON.stringify(r.out));
});

await check("MUST-STOP: blank again after the second check — refused, nothing clicked, a review stop and not an incident", async () => {
  const r = await drive({ required: [[], ["Application Date"], [], ["Application Date"]] });
  assert.equal(r.clicks, 0, JSON.stringify(r.calls));
  assert.equal(r.out.kind, "refused", JSON.stringify(r.out));
  assert.ok((r.out.refusals ?? []).some((x) => /went blank again/.test(x) && x.includes("Application Date")), JSON.stringify(r.out));
  assert.equal(r.out.incident, undefined);
});

await check("MUST-STOP: the second check's own required read still refuses (the re-assert did not repair it)", async () => {
  const r = await drive({ required: [[], ["Application Date"], ["Application Date"]] });
  assert.equal(r.clicks, 0, JSON.stringify(r.calls));
  assert.equal(r.out.kind, "refused", JSON.stringify(r.out));
  assert.ok((r.out.refusals ?? []).some((x) => /required field\(s\) still empty on the page: Application Date/.test(x)), JSON.stringify(r.out));
});

await check("MUST-STOP: the second check never skips a guard — a pick in front, or a control that no longer reads as the stamped one, still stops", async () => {
  const picked = await drive({ required: [[], ["Application Date"], []], picks: [[], ["re-assert: Preferred Contact Method"]] });
  assert.equal(picked.clicks, 0, JSON.stringify(picked.calls));
  assert.equal(picked.out.kind, "refused");
  assert.ok((picked.out.refusals ?? []).some((x) => /no project data behind them/.test(x)), JSON.stringify(picked.out));

  const relabelled = await drive({ required: [[], ["Application Date"], []], labels: ["Submit", "Submit Application and Pay"] });
  assert.equal(relabelled.clicks, 0, JSON.stringify(relabelled.calls));
  assert.equal(relabelled.out.kind, "refused");
  assert.ok((relabelled.out.refusals ?? []).some((x) => /the control on the page reads "Submit Application and Pay"/.test(x)), JSON.stringify(relabelled.out));
});

await check("MUST-STOP: a field blank at the FIRST read is refused as before — no second pass, nothing clicked", async () => {
  const r = await drive({ required: [["Application Date"]] });
  assert.deepEqual(r.calls, ["reassert", "gapfill", "picks", "required"], JSON.stringify(r.calls));
  assert.equal(r.out.kind, "refused");
});

await check("the gate is asked first and unchanged; the last read sits between the ready check and the click", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "recipeAdapter.ts"), "utf8");
  const fn = src.slice(src.indexOf("private async clickDraftCreatingSubmit("), src.indexOf("private finalSubmitRefusalsNow("));
  const at = (needle: string): number => { const i = fn.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const gate = at("draftCreatingClickRefusals(this.recipe.steps, idx,");
  const gateStops = at('if (refusals.length) return { kind: "refused", refusals };');
  const firstCheck = at("const notReady = await readyCheck();");
  const lastRead = at("const blankedSince = await this.emptyRequiredControls()");
  const marked = at("this.draftSubmitAttempted = true;");
  const click = at("await this.guardedClick(scoped,");
  assert.ok(gate < gateStops && gateStops < firstCheck && firstCheck < lastRead && lastRead < marked && marked < click, "order: gate, ready check, last read, mark, click");
  assert.equal((fn.match(/this\.guardedClick\(/g) ?? []).length, 1, "one click site");
  assert.equal((fn.match(/draftCreatingClickRefusals\(/g) ?? []).length, 1, "the gate is asked once, by its own function");
});

console.log(failures === 0
  ? "\nAll draft-submit ready-at-click checks passed."
  : `\n${failures} draft-submit ready-at-click check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
