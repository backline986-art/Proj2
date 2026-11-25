// THE ATTACHMENT ROW'S SAVE, NEVER THE PAGE'S "SAVE AND RESUME LATER" (attachmentSave.ts).
// Real Chromium on a local page shaped like Accela Citizen Access (never a real portal).
//
//   A1 ATTACHMENT_SAVE_CSS finds the attachment widget's Save and not the action bar's draft save.
//   A2 on a page whose only btnSave is the action bar's "Save and resume later", it finds nothing
//      (the old fallback clicked it: the offline bench's Accela replays, 45 s each).
//   A3 a recipe step recorded with the old loose fallback is tightened for replay; any other step
//      is left exactly as it is.
//
// KILL TESTS (each must turn this file red):
//   K1 ATTACHMENT_SAVE_CSS = LOOSE_ATTACHMENT_SAVE_CSS              → A1 A2 fail.
//   K2 tightenAttachmentSaveStep: return step at the top          → A3 fails.
//
// Run: npx tsx portal-bot/src/attachmentSave.dom.smoke.ts
import "./smokeArtifactDirs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { RecipeStep } from "../../shared/src/types";
import { ATTACHMENT_SAVE_CSS, LOOSE_ATTACHMENT_SAVE_CSS, tightenAttachmentSaveStep } from "./attachmentSave";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const PM = "ctl00_PlaceHolderMain_";
const actionBar = `<div class="ACA_ActionBar"><a id="${PM}actionBarBottom_btnContinue" href="#">Continue Application &raquo;</a>
  <a id="${PM}actionBarBottom_btnSave" class="ACA_LinkButton" href="#">Save and resume later</a></div>`;

const browser = await chromium.launch();
const page = await browser.newPage();

await check("A1 the attachment widget's Save is found, never the action bar's draft save", async () => {
  await page.setContent(`<!doctype html><html><body>
    <div id="${PM}Attachment_24Edit"><input type="file"><a id="${PM}Attachment_24Edit_btnSave" title="Save" href="#"><span>Save</span></a></div>
    ${actionBar}</body></html>`);
  const hits = page.locator(ATTACHMENT_SAVE_CSS);
  assert.equal(await hits.count(), 1);
  assert.equal(await hits.first().getAttribute("id"), `${PM}Attachment_24Edit_btnSave`);
});

await check("A2 with only the action bar's \"Save and resume later\" on the page, nothing is found", async () => {
  await page.setContent(`<!doctype html><html><body><input type="file">${actionBar}</body></html>`);
  assert.equal(await page.locator(ATTACHMENT_SAVE_CSS).count(), 0);
  // the old fallback did find it — the reason for this file
  assert.equal(await page.locator(LOOSE_ATTACHMENT_SAVE_CSS).count(), 1);
});

await check("A3 a recipe's old attachment Save step is tightened for replay; other steps are untouched", () => {
  const old: RecipeStep = {
    action: "click", phase: "upload", note: "attachment: save (commits the upload)",
    selector: { role: "link", name: "Save", exact: true, fallbacks: [{ css: LOOSE_ATTACHMENT_SAVE_CSS }, { role: "button", name: "Save", exact: true }] },
  } as RecipeStep;
  const t = tightenAttachmentSaveStep(old);
  assert.equal(t.selector?.fallbacks?.[0]?.css, ATTACHMENT_SAVE_CSS);
  assert.equal(t.selector?.name, "Save");
  assert.equal(old.selector?.fallbacks?.[0]?.css, LOOSE_ATTACHMENT_SAVE_CSS, "the recipe's own step object is not mutated");
  const advance = { action: "click", note: "advance: Continue Application »", selector: { css: LOOSE_ATTACHMENT_SAVE_CSS } } as RecipeStep;
  assert.equal(tightenAttachmentSaveStep(advance), advance);
  assert.equal(tightenAttachmentSaveStep(undefined), undefined);
});

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} attachment Save smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll attachment Save smoke tests passed.");
process.exit(0);
