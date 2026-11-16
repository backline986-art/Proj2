// TYPED UPLOADER — real Chromium. Run: npx tsx portal-bot/src/adapters/typedUploader.dom.smoke.ts
//
// A self-service portal's uploader is ONE file box, a Document Type list and an "Add Attachment" button
// that commits the pair (EnerGov's "Select Type + Add Attachment" rows; the bench's selfserve base). The
// learn used to set the file and walk on: the portal kept nothing. findTypedUploader finds that
// container, and the attachment-row pass (accelaAttachmentSavePass, now scoped to it) picks the Type the
// document takes, clicks the container's own commit, proves it by the file NAME in the page's list, and
// records the row in the replay's attachment-row vocabulary ("attachment: document type" /
// "attachment: save (commits the upload)").
//
// MUST-PASS  [1] the uploader is found, Type "Plans" picked, Add clicked, the file listed; the recipe
//                gains the select + the commit step named as the portal names it.
// MUST-NOT   [2] a file box beside a NON-document list ("Work Type") is not an uploader;
//            [3] a file box whose container has no commit control is not one;
//            [4] the container's "Submit Application" is never the commit (only add/upload/attach/save);
//            [5] a commit the page never lists the file for is reported NOT committed.
// KILL: make findTypedUploader return null -> [1] fails; drop the COMMIT name test -> [4] fails.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutoLearnAdapter } from "./autoLearnAdapter";
import type { RecipeStep } from "../../../shared/src/types";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ FAIL - ${name}${detail ? `: ${detail}` : ""}`); }
}

const TYPES = `<option value="">--Select--</option><option value="P">Plans</option><option value="E">Electrical One-Line</option><option value="S">Site Plan</option><option value="O">Other</option>`;
const uploaderPage = (opts: { list?: boolean; select?: string; commit?: string } = {}): string => `<!doctype html><html><body>
<h1>Attachments</h1>
<div class="uploader">
  <div class="field"><label for="docType">Document Type</label><select id="docType">${opts.select ?? TYPES}</select></div>
  <div class="field"><label for="docFile">File</label><input type="file" id="docFile"></div>
  ${opts.commit ?? '<button type="button" id="btnAdd">Add Attachment</button>'}
  <button type="button" id="btnSubmit" onclick="window.__submitted=1">Submit Application</button>
</div>
<table><thead><tr><th>Type</th><th>File</th><th>Status</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>
<script>
  window.__adds = 0;
  var add = document.getElementById('btnAdd');
  if (add) add.addEventListener('click', function () {
    window.__adds++;
    var sel = document.getElementById('docType'); var f = document.getElementById('docFile');
    if (!sel.value || !f.files[0]) return;
    ${opts.list === false ? "" : "var tr = document.createElement('tr'); tr.innerHTML = '<td>' + sel.options[sel.selectedIndex].text + '</td><td>' + f.files[0].name + '</td><td>Uploaded</td><td>Remove</td>'; document.getElementById('rows').appendChild(tr);"}
    window.__type = sel.options[sel.selectedIndex].text; f.value = ''; sel.value = '';
  });
</script></body></html>`;

const pdf = join(tmpdir(), "typed-uploader-plan-set.pdf");
writeFileSync(pdf, "%PDF-1.4\n%synthetic\n");
const project = { permitType: "electrical", projectAddress: "1 Test St, Springfield, IL, 62701" } as never;
const uploadStep = (): RecipeStep => ({ action: "upload", phase: "upload", selector: { label: "File" }, docType: "plan_set", note: "upload: File" } as RecipeStep);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const adapter = new AutoLearnAdapter("Typed Uploader Smoke", null as never, { maxPages: 1 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  a.page = page;

  // [1] MUST-PASS
  await page.setContent(uploaderPage());
  await page.setInputFiles("#docFile", pdf);
  const up = await a.findTypedUploader();
  check("[1] the typed uploader is found, its commit named as the portal names it",
    !!up && up.name === "Add Attachment" && up.role === "button" && up.fileName === "typed-uploader-plan-set.pdf", JSON.stringify(up));
  const steps: RecipeStep[] = [uploadStep()];
  const committed = up ? await a.accelaAttachmentSavePass(project, steps, up) : false;
  const st = await page.evaluate(() => ({ adds: (window as never as { __adds: number }).__adds, type: (window as never as { __type?: string }).__type, submitted: (window as never as { __submitted?: number }).__submitted }));
  check("[1] Type 'Plans' picked and Add clicked once; the page lists the file", committed === true && st.adds === 1 && st.type === "Plans", JSON.stringify({ committed, st }));
  const sel = steps.find((s) => s.action === "select");
  const commit = steps.find((s) => s.action === "click");
  check("[1] the recipe records the row: 'attachment: document type' = Plans, then the commit as 'attachment: save' on the Add Attachment button",
    !!sel && sel.value === "Plans" && /^attachment:\s*document type/.test(String(sel.note)) &&
    !!commit && /^attachment:\s*save\b/.test(String(commit.note)) && commit.selector?.role === "button" && commit.selector?.name === "Add Attachment",
    JSON.stringify(steps.slice(1)));
  check("[1] the container's Submit Application was never clicked", !st.submitted);

  // [2] a non-document list
  await page.setContent(uploaderPage({ select: `<option value="">--Select--</option><option>Residential</option><option>Commercial</option>` }));
  await page.setInputFiles("#docFile", pdf);
  check("[2] a file box beside a 'Work Type' list is not a typed uploader", (await a.findTypedUploader()) === null);

  // [3] no commit control
  await page.setContent(uploaderPage({ commit: "" }));
  await page.setInputFiles("#docFile", pdf);
  check("[3] a file box whose container has no commit control is not a typed uploader", (await a.findTypedUploader()) === null);

  // [4] only Submit in the container
  await page.setContent(uploaderPage({ commit: '<button type="button" id="btnNext">Next</button>' }));
  await page.setInputFiles("#docFile", pdf);
  check("[4] Submit Application / Next are never a commit", (await a.findTypedUploader()) === null);

  // [5] the page never lists the file
  await page.setContent(uploaderPage({ list: false }));
  await page.setInputFiles("#docFile", pdf);
  const up5 = await a.findTypedUploader();
  const ok5 = up5 ? await a.accelaAttachmentSavePass(project, [uploadStep()], up5) : true;
  check("[5] a commit the page never lists the file for is NOT committed", !!up5 && ok5 === false, JSON.stringify({ up5, ok5 }));
} finally {
  await browser.close();
}

console.log(`\ntypedUploader: ${passed} passed, ${failed} failed (of ${passed + failed} checks)`);
if (failed) { console.log("FAIL - typedUploader"); process.exit(1); }
console.log("All typed-uploader checks passed (real Chromium).");
