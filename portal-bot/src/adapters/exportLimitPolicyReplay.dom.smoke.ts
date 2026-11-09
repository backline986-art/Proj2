// A RECORDED "POLICY DEFAULT" EXPORT-CAPACITY ANSWER YIELDS TO THE JOB (issue #355) — real Chromium,
// the real replay path.
//
// The learner's policy pass answers "Do you propose to limit the export capacity of this system?" with
// the standing "No" and records it as a literal: a `check` on the "No" radio (PGE's shape: per-render
// PowerClerk ids, options wrapped in their <label>), or a `select` of "No", noted
// "policy default: <question> → No". Until #355 nothing rebound it, so a replay on an export-limited
// job (PCS / export limit / non-export / NGOM) filed "No".
//
// A SYNTHETIC page (no customer data): the question as a required radio group, a Next, a review page.
//   [R1] radio, exportLimiting "Yes" (the job's evidence) → "Yes" is committed, and the note says so;
//   [R2] radio, exportLimiting "No" with evidence → "No";
//   [R3] radio, exportLimiting "No" flagged no evidence (#356) → the standing "No", noted as such;
//   [R4] radio, no exportLimiting on the job → the recorded "No";
//   [R5] the recorded id no longer exists (per-render suffix) → re-anchored, then the job's "Yes";
//   [R6] a note that names only an option ("policy default: Yes → No") → the live group's question
//        decides it: "Yes";
//   [R7] the group offers no "Yes" → nothing is checked (never the standing "No" in its place), named;
//   [K]  another policy radio (lab-certified, standing "Yes") on the same page is untouched by it;
//   [S1] select, exportLimiting "Yes" → "Yes";  [S2] select, no evidence → the standing "No".
//
// Kill check: on main (before #355) R1, R5, R6 and S1 commit "No" and R7 checks "No".
//
//   npx tsx portal-bot/src/adapters/exportLimitPolicyReplay.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const Q = "Do you propose to limit the export capacity of this system?";
const LAB = "Are all inverters lab-certified?";

const radioGroup = (name: string, question: string, options: string[], key: string, questionFirst = true): string => {
  const opts = options.map((o, i) => `<label class="radio-inline"><input type="radio" name="${name}" id="${name}Input_${11512 + i}" value="${i + 1}" required data-k="${key}"> ${o}</label>`).join("\n");
  const q = `<span class="question">${question}</span><span class="text-danger"> * </span>`;
  return `<div class="form-group">${questionFirst ? `${q}\n${opts}` : `${opts}\n${q}`}</div>`;
};

const PAGE = (v: string): string => {
  const exportCtl = v === "s"
    ? `<div class="form-group"><label for="XSELInput">${Q}</label><span class="text-danger"> * </span>
        <select id="XSELInput" required data-k="exportAnswer"><option value="">Select...</option><option value="1">Yes</option><option value="2">No</option></select></div>`
    : v === "n" ? radioGroup("XPROP", Q, ["Not sure", "No"], "exportAnswer")
      : v === "o" ? radioGroup("XPROP", Q, ["Yes", "No"], "exportAnswer", false)
        : radioGroup("XPROP", Q, ["Yes", "No"], "exportAnswer");
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px sans-serif;padding:12px}.form-group{margin:12px 0}</style></head><body>
  <h2>Generation System Information</h2>
  ${exportCtl}
  ${radioGroup("LABC", LAB, ["Yes", "No"], "labAnswer")}
  <button id="next" type="button">Next</button>
  <script>
    var server = { exportAnswer: "", labAnswer: "" };
    window.__server = server;
    var els = document.querySelectorAll("[data-k]");
    for (var i = 0; i < els.length; i++) (function (el) {
      el.addEventListener("change", function () {
        var k = el.getAttribute("data-k");
        if (el.tagName === "SELECT") server[k] = el.value ? el.options[el.selectedIndex].text : "";
        else if (el.checked) server[k] = (el.closest("label") || el).textContent.trim();
      });
    })(els[i]);
    document.getElementById("next").addEventListener("click", function () {
      sessionStorage.setItem("srv", JSON.stringify(server));
      location.href = "/review";
    });
  </script>
</body></html>`;
};

const REVIEW_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <h1>Review and Submit</h1>
  <p>Please review your application before submitting.</p>
  <button type="button" id="submitapp">Submit Application</button>
  <script>
    window.__server = JSON.parse(sessionStorage.getItem("srv") || "{}");
    document.getElementById("submitapp").addEventListener("click", function () { window.__filed = true; });
  </script>
</body></html>`;

const server = http.createServer((q, r) => {
  const url = new URL(String(q.url ?? "/"), "http://fixture.invalid");
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(url.pathname.startsWith("/review") ? REVIEW_PAGE : PAGE(url.searchParams.get("v") || ""));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Shaped like a learned PGE recipe's generation page: the two policy answers the learner's pass
// recorded, Next, review. The export radio's recorded id is the "No" option's.
const recipe = (url: string, exportStep: RecipeStep): PortalRecipe => ({
  id: "pge355", scopeType: "utility", profileKey: "ca|unknown|pge", state: "CA", ahj: "", utility: "PG&E",
  portalPlatform: "auto-learned", portalUrl: url, status: "complete", version: 1,
  steps: [
    exportStep,
    { action: "check", phase: "fill", selector: { css: "#LABCInput_11512" }, note: `policy default: ${LAB} → Yes` },
    { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true }, note: "advance: Next" },
    { action: "stopForReview", phase: "review", note: "review" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const RADIO_STEP: RecipeStep = { action: "check", phase: "fill", selector: { css: "#XPROPInput_11513" }, note: `policy default: ${Q} → No` } as RecipeStep;
const SELECT_STEP: RecipeStep = { action: "select", phase: "fill", selector: { css: "#XSELInput" }, value: "No", note: `policy default: ${Q} → No` } as RecipeStep;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const run = async (fields: Record<string, string>, step: RecipeStep, v = "") => {
  const p = await context.newPage();
  const path = v ? `/?v=${v}` : "/";
  await p.goto(`${base}${path}`);
  const a = new RecipeAdapter(recipe(`${base}${path}`, step), fields, {}, { autoSubmit: false });
  (a as unknown as { page: unknown }).page = p;
  const r = await a.fillApplication({} as never);
  // On the form page (a stop) the live radios are read; at review, the saved answers.
  const committed = await p.evaluate(() => (window as unknown as { __server: Record<string, string> }).__server);
  const noChecked = await p.evaluate(() => {
    const els = Array.from(document.querySelectorAll('input[name="XPROP"]')) as HTMLInputElement[];
    return els.filter((e) => e.checked).map((e) => (e.closest("label")?.textContent || "").trim());
  }).catch(() => [] as string[]);
  const filed = await p.evaluate(() => (window as unknown as { __filed?: boolean }).__filed === true);
  const url = p.url();
  await p.close();
  const data = ((r as unknown as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  const notes = [...((data.agingNotes as string[] | undefined) ?? []), ...((data.driftWarnings as string[] | undefined) ?? [])];
  return { r, data, committed, checkedNow: noChecked, filed, url, notes };
};
type Run = Awaited<ReturnType<typeof run>>;
const outline = (w: Run): string =>
  `ok=${w.r.ok} url=${w.url.replace(base, "")} committed=${JSON.stringify(w.committed)} checkedNow=${JSON.stringify(w.checkedNow)} message=${String(w.r.message ?? "").slice(0, 240)} notes=${JSON.stringify(w.notes).slice(0, 600)}`;
const noteFor = (w: Run, needle: string): boolean => w.notes.some((n) => n.includes(Q.slice(0, 40)) && n.includes(needle));

const LIMITED = { exportLimiting: "Yes", exportLimitingNoEvidence: "" };

console.log("\n[R1] radio recorded as the standing No; the job is export-limited (exportLimiting Yes)");
const R1 = await run(LIMITED, RADIO_STEP);
console.log(`   ${outline(R1)}`);
check("[R1] the run reaches review", R1.r.ok === true && R1.url.endsWith("/review"), outline(R1));
check("[R1] the export-capacity answer = Yes (the job's exportLimiting, never the recorded No)", R1.committed.exportAnswer === "Yes", outline(R1));
check("[R1] the note says it is the job's own answer, not the recorded standing No", noteFor(R1, "from exportLimiting") && noteFor(R1, "not the recorded standing"), outline(R1));
check("[K] the lab-certified policy answer is untouched (Yes, as recorded)", R1.committed.labAnswer === "Yes", outline(R1));
check("[R1] nothing was filed", R1.filed === false, outline(R1));

console.log("\n[R2] the job's own No (evidence)");
const R2 = await run({ exportLimiting: "No", exportLimitingNoEvidence: "" }, RADIO_STEP);
console.log(`   ${outline(R2)}`);
check("[R2] reaches review with No", R2.r.ok === true && R2.committed.exportAnswer === "No", outline(R2));
check("[R2] the note says No is the job's own answer", noteFor(R2, "from exportLimiting"), outline(R2));

console.log("\n[R3] no export-limiting evidence on the job (#356)");
const R3 = await run({ exportLimiting: "No", exportLimitingNoEvidence: "1" }, RADIO_STEP);
console.log(`   ${outline(R3)}`);
check("[R3] reaches review with the standing No", R3.r.ok === true && R3.committed.exportAnswer === "No", outline(R3));
check("[R3] noted as the standing answer, never \"from exportLimiting\"",
  noteFor(R3, "standing answer, no evidence on the job") && !noteFor(R3, "from exportLimiting"), outline(R3));

console.log("\n[R4] no exportLimiting on the job at all");
const R4 = await run({}, RADIO_STEP);
console.log(`   ${outline(R4)}`);
check("[R4] reaches review with the recorded No", R4.r.ok === true && R4.committed.exportAnswer === "No", outline(R4));

console.log("\n[R5] the recorded id carries a per-render suffix that no longer exists");
const R5 = await run(LIMITED, { ...RADIO_STEP, selector: { css: "#XPROPInput_99913" } } as RecipeStep);
console.log(`   ${outline(R5)}`);
check("[R5] re-anchored, then the job's Yes", R5.r.ok === true && R5.committed.exportAnswer === "Yes", outline(R5));

console.log("\n[R6] the note names only an option (label-wrapped radios before the question)");
const R6 = await run(LIMITED, { ...RADIO_STEP, note: "policy default: Yes → No" } as RecipeStep, "o");
console.log(`   ${outline(R6)}`);
check("[R6] the live group's question decides it: Yes", R6.r.ok === true && R6.committed.exportAnswer === "Yes", outline(R6));

console.log("\n[R7] the group offers no Yes (\"Not sure\" / \"No\")");
const R7 = await run(LIMITED, RADIO_STEP, "n");
console.log(`   ${outline(R7)}`);
check("[R7] the standing No is never checked in place of the job's Yes",
  R7.committed.exportAnswer !== "No" && !R7.checkedNow.includes("No"), outline(R7));
check("[R7] the blank is named for a person", R7.notes.some((n) => n.includes("left unanswered for a person") && n.includes("exportLimiting")), outline(R7));
check("[R7] nothing was filed", R7.filed === false, outline(R7));

console.log("\n[S1] select recorded as the standing No; the job is export-limited");
const S1 = await run(LIMITED, SELECT_STEP, "s");
console.log(`   ${outline(S1)}`);
check("[S1] the export-capacity select = Yes", S1.r.ok === true && S1.committed.exportAnswer === "Yes", outline(S1));
check("[S1] the note says it is the job's own answer", noteFor(S1, "from exportLimiting"), outline(S1));

console.log("\n[S2] select, no evidence on the job");
const S2 = await run({ exportLimiting: "No", exportLimitingNoEvidence: "1" }, SELECT_STEP, "s");
console.log(`   ${outline(S2)}`);
check("[S2] the standing No", S2.r.ok === true && S2.committed.exportAnswer === "No", outline(S2));
check("[S2] noted as the standing answer", noteFor(S2, "standing answer, no evidence on the job"), outline(S2));

await browser.close();
server.close();
if (failures) {
  console.error(`\nexportLimitPolicyReplay: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nexportLimitPolicyReplay: all checks passed");
