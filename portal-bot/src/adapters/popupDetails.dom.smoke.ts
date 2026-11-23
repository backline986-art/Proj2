// POP-UP DETAILS (#131) — real Chromium. Run: npx tsx portal-bot/src/adapters/popupDetails.dom.smoke.ts
//
// A self-service portal keeps a page's fields in a POP-UP: a button ("Add Project Details") opens a
// dialog (role=dialog, aria-modal) whose boxes post nothing; only the dialog's Save copies them into the
// page's hidden inputs (EnerGov; the bench's selfserve base). The learn skipped all three boxes as
// "hidden, no opener", so the portal kept nothing; and a replay that did open it had its dialog closed
// by the modal dismissor (its Cancel) before the Save.
//
// LEARN (planHiddenReveal rule 5 + tryRevealHidden + popupCommitPass):
// MUST-PASS [1] a hidden box inside the dialog: the opener whose words carry the dialog title's words
//               is clicked, the box shows, the click is recorded ("pop-up: open (...)"); after the fill,
//               the dialog's Save is clicked, the dialog closes, the page's hidden input holds the
//               value, and "pop-up: save (commits the pop-up)" is recorded.
// MUST-NOT  [2] two controls carry the title's words ("Add Project Details" / "Edit Project Details"):
//               ambiguous, nothing is opened;
//           [3] the only worded control is "Submit Project Details": never an opener;
//           [4] the dialog's only button is "Submit": nothing is clicked, nothing recorded;
//           [6] a DECLARED opener (aria-haspopup="dialog") named "Complete Application" is never clicked
//               (the shared submit-intent predicate, Helm review of #268);
//           [7] a dialog TITLED "Submit Application", opened by an innocently named control: its OK is
//               never clicked (the dialog is judged, not only its button);
//           [8] a dialog holding a signature-name box is not committed.
// REPLAY:
// MUST-PASS [5] the recorded open / fill / save replays: the dialog is NOT dismissed between the open
//               and the Save, the page's hidden input holds THIS job's value.
// KILL: drop the `!popupNote && !this.recipePopupOpen` guard in recipeAdapter -> [5] fails; drop the
//       pop-up rule in revealHidden.ts -> [1] fails; drop the popupControlRefused(plan.popup.name) refusal
//       in tryRevealHidden -> [6] fails; drop popupControlRefused(found.title) in popupCommitPass -> [7]
//       fails; drop the signatureBox test there -> [8] fails.
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.PORTAL_REPLAY_STALL_MINUTES = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const page = (opts: { openers?: string; dialogButtons?: string; title?: string; extraBoxes?: string } = {}): string => `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title>
<style>.modal{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100}.modal-content{background:#fff;margin:60px auto;padding:16px;max-width:520px}[hidden]{display:none}</style></head><body>
<main><h1>Project Details</h1><p id="summary">No project details entered.</p>
${opts.openers ?? '<button type="button" id="btnOpen" class="opener">Add Project Details</button>'}
<input type="hidden" name="Details.DcKw" value="">
<button type="button" id="btnSaveDraft">Save Draft</button> <button type="button" id="btnNext">Next</button>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlgTitle" id="dlg" hidden><div class="modal-content">
<h2 id="dlgTitle">${opts.title ?? "Project Details"}</h2>
<div class="field"><label for="fld_dcKw">System Size (kW DC)</label><input type="text" id="fld_dcKw" data-name="Details.DcKw"></div>
${opts.extraBoxes ?? ""}
${opts.dialogButtons ?? '<button type="button" id="btnDialogSave">Save</button><button type="button" id="btnDialogCancel">Cancel</button>'}
</div></div></main>
<script>
  var dlg = document.getElementById('dlg');
  window.__openClicks = 0; window.__commitClicks = 0;
  document.querySelectorAll('.opener').forEach(function (b) { b.addEventListener('click', function () { window.__openClicks++; dlg.hidden = false; }); });
  dlg.querySelectorAll('button').forEach(function (b) { if (!/cancel/i.test(b.textContent)) b.addEventListener('click', function () { window.__commitClicks++; }); });
  var save = document.getElementById('btnDialogSave');
  if (save) save.addEventListener('click', function () {
    var box = document.getElementById('fld_dcKw');
    document.querySelector('input[type=hidden][name="Details.DcKw"]').value = box.value;
    document.getElementById('summary').textContent = box.value ? '1 detail(s) saved.' : 'No project details entered.';
    dlg.hidden = true;
  });
  var cancel = document.getElementById('btnDialogCancel');
  if (cancel) cancel.addEventListener('click', function () { dlg.hidden = true; });
</script></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page());
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const fresh = async (): Promise<Page> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  return ctx.newPage();
};
const learner = (p: Page) => {
  const adapter = new AutoLearnAdapter("Popup Details Smoke", null as never, { maxPages: 1 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  a.page = p;
  return a;
};
const hiddenHolds = (p: Page): Promise<string> => p.evaluate(() => (document.querySelector('input[type=hidden][name="Details.DcKw"]') as HTMLInputElement).value);
const dialogShown = (p: Page): Promise<boolean> => p.locator("#dlg").isVisible();
const field = { label: "System Size (kW DC)", fieldType: "text" } as never;

// [1] MUST-PASS
{
  const p = await fresh();
  await p.setContent(page());
  const a = learner(p);
  const box = p.locator("#fld_dcKw");
  const revealed = await a.tryRevealHidden(box, field);
  const opened = a.typeaheadDoorSteps.splice(0) as RecipeStep[];
  check("[1] the pop-up is opened by its worded opener, the box shows", revealed === true && await dialogShown(p), `revealed=${revealed}`);
  check("[1] the opener's click is recorded as 'pop-up: open'", opened.length === 1 && opened[0].selector?.name === "Add Project Details" && /^pop-up: open/.test(String(opened[0].note)), JSON.stringify(opened));
  await box.fill("7.2");
  const steps: RecipeStep[] = [];
  const committed = await a.popupCommitPass(steps, 1);
  check("[1] the dialog's Save is clicked, the dialog closes, the page holds the value", committed === true && !(await dialogShown(p)) && (await hiddenHolds(p)) === "7.2", JSON.stringify({ committed, held: await hiddenHolds(p) }));
  check("[1] the Save is recorded as 'pop-up: save (commits the pop-up)'", steps.length === 1 && steps[0].selector?.name === "Save" && steps[0].note === "pop-up: save (commits the pop-up)", JSON.stringify(steps));
  await p.context().close();
}

// [2] / [3] MUST-NOT openers
for (const [tag, openers, why] of [
  ["[2]", '<button type="button" class="opener">Add Project Details</button> <button type="button" class="opener">Edit Project Details</button>', "two worded controls: ambiguous, nothing opened"],
  ["[3]", '<button type="button" class="opener">Submit Project Details</button>', "a submit-worded control is never an opener"],
] as const) {
  const p = await fresh();
  await p.setContent(page({ openers }));
  const a = learner(p);
  const revealed = await a.tryRevealHidden(p.locator("#fld_dcKw"), field);
  const opened = a.typeaheadDoorSteps.splice(0);
  check(`${tag} ${why}`, revealed === false && !(await dialogShown(p)) && opened.length === 0, JSON.stringify({ revealed, opened }));
  await p.context().close();
}

// [4] MUST-NOT: the dialog's only button is "Submit".
{
  const p = await fresh();
  await p.setContent(page({ dialogButtons: '<button type="button" id="btnDialogSubmit" onclick="window.__submitted=1">Submit</button>' }));
  const a = learner(p);
  await a.tryRevealHidden(p.locator("#fld_dcKw"), field);
  a.typeaheadDoorSteps.splice(0);
  await p.locator("#fld_dcKw").fill("7.2");
  const steps: RecipeStep[] = [];
  const committed = await a.popupCommitPass(steps, 1);
  const submitted = await p.evaluate(() => (window as unknown as { __submitted?: number }).__submitted);
  check("[4] a dialog whose only button is Submit: nothing clicked, nothing recorded", committed === false && !submitted && steps.length === 0, JSON.stringify({ committed, submitted, steps }));
  await p.context().close();
}

// [6] / [7] / [8] MUST-NOT (Helm review of #268), each with click counters on the fixture.
const clicks = (p: Page): Promise<{ open: number; commit: number }> =>
  p.evaluate(() => ({ open: Number((window as unknown as { __openClicks?: number }).__openClicks || 0), commit: Number((window as unknown as { __commitClicks?: number }).__commitClicks || 0) }));
{
  const p = await fresh();
  await p.setContent(page({ openers: '<button type="button" class="opener" aria-haspopup="dialog">Complete Application</button>' }));
  const a = learner(p);
  const revealed = await a.tryRevealHidden(p.locator("#fld_dcKw"), field);
  const opened = a.typeaheadDoorSteps.splice(0);
  const c = await clicks(p);
  check("[6] a declared opener named 'Complete Application' is never clicked", revealed === false && c.open === 0 && opened.length === 0 && !(await dialogShown(p)), JSON.stringify({ revealed, c, opened }));
  await p.context().close();
}
{
  const p = await fresh();
  await p.setContent(page({
    title: "Submit Application",
    openers: '<button type="button" class="opener" aria-haspopup="dialog">Details</button>',
    dialogButtons: '<button type="button" id="btnDialogOk">OK</button>',
  }));
  const a = learner(p);
  const revealed = await a.tryRevealHidden(p.locator("#fld_dcKw"), field);
  a.typeaheadDoorSteps.splice(0);
  await p.locator("#fld_dcKw").fill("7.2").catch(() => null);
  const steps: RecipeStep[] = [];
  const committed = await a.popupCommitPass(steps, 1);
  const c = await clicks(p);
  check("[7] a dialog titled 'Submit Application' is opened by its innocent opener, and its OK is never clicked", revealed === true && committed === false && c.commit === 0 && steps.length === 0, JSON.stringify({ revealed, committed, c, steps }));
  await p.context().close();
}
{
  const p = await fresh();
  await p.setContent(page({ extraBoxes: '<div class="field"><label for="fld_sig">Applicant Signature</label><input type="text" id="fld_sig"></div>' }));
  const a = learner(p);
  const revealed = await a.tryRevealHidden(p.locator("#fld_dcKw"), field);
  a.typeaheadDoorSteps.splice(0);
  await p.locator("#fld_dcKw").fill("7.2").catch(() => null);
  const steps: RecipeStep[] = [];
  const committed = await a.popupCommitPass(steps, 1);
  const c = await clicks(p);
  check("[8] a pop-up holding a signature-name box is not committed (its Save never clicked)", revealed === true && committed === false && c.commit === 0 && steps.length === 0, JSON.stringify({ revealed, committed, c, steps }));
  await p.context().close();
}

// [5] REPLAY
{
  const p = await fresh();
  const recipe = {
    id: "r131", scopeType: "ahj", profileKey: "id|fernhollow|x", state: "ID", ahj: "City of Fernhollow", utility: "",
    portalPlatform: "auto-learned", portalUrl: `${base}/Details`, status: "complete", version: 1, discipline: "electrical",
    steps: [
      { action: "goto", phase: "open", value: `${base}/Details`, note: "entry url" },
      { action: "click", phase: "fill", selector: { role: "button", name: "Add Project Details", exact: true, fallbacks: [{ css: "#btnOpen" }] }, note: "pop-up: open (Add Project Details)" },
      { action: "fill", phase: "fill", selector: { label: "System Size (kW DC)", fallbacks: [{ css: "#fld_dcKw" }] }, field: "systemSizeDcKw", note: "System Size (kW DC)" },
      { action: "click", phase: "fill", selector: { role: "button", name: "Save", exact: true, fallbacks: [{ css: "#btnDialogSave" }] }, note: "pop-up: save (commits the pop-up)" },
    ],
    createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { systemSizeDcKw: "9.6" }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = p;
  const t0 = Date.now();
  const run = adapter.fillApplication({} as ProjectRecord).catch((e: unknown) => ({ ok: false, message: `threw ${String(e).slice(0, 200)}` }));
  const res = await Promise.race([run, new Promise<{ ok: boolean; message: string }>((r) => setTimeout(() => r({ ok: false, message: "TIMED OUT" }), 100_000))]) as { ok: boolean; message: string };
  const held = await hiddenHolds(p).catch(() => "(unreadable)");
  console.log(`   [5] ok=${res.ok} ${((Date.now() - t0) / 1000).toFixed(1)}s held=${held} msg=${String(res.message).slice(0, 200)}`);
  check("[5] the replay opens the pop-up, fills it and its Save commits THIS job's value (never dismissed between)", held === "9.6", `held=${held}`);
  check("[5] ...in seconds, no stall", Date.now() - t0 < 60_000 && !/TIMED OUT/.test(res.message), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await p.context().close();
}

await browser.close();
server.close();
if (failures > 0) { console.error(`\npopupDetails.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\npopupDetails.dom.smoke: PASS");
process.exit(0);
