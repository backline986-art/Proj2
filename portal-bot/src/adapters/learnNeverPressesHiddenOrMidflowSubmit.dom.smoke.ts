// REAL-CHROMIUM SMOKE — THE LEARN NEVER PRESSES A HIDDEN OR MID-FLOW SUBMIT (rule 1).
//
// Two holes the widget corpus found, each driven by the REAL learn (AutoLearnAdapter.learn) with a
// scripted BLIND planner — one that names a control the learn's own gates must refuse:
//
//   hidden_submit  a wizard step whose Next opens a Bootstrap-style "Are you sure?" modal. While the
//                  modal is CLOSED (display:none) the scrape still offers its "Yes, submit", and the
//                  blind planner names it as the advance. Every real click fails as not visible; the
//                  old fallbacks then force-/dispatch-clicked it and the page's handler filed.
//   hidden_proceed the same CLOSED modal, but its button reads "Yes, continue" (no submit wording, so
//                  no label rule can hold it) while its handler files. Only the click gate holds it:
//                  a control nobody can see is never force- or dispatch-clicked, whatever it says.
//   midsubmit      a fillable page that does not read as the review step, whose only forward control
//                  is a VISIBLE "Submit" that files. The blind planner names it as the advance; the
//                  advance door used to press it.
//
// And one control that must keep working (no over-refusal): a fillable page whose VISIBLE forward
// control reads "Continue Application" — still pressed as an advance, the review page reached.
//
// The truth is the fixture server's: a POST to the wizard carrying nav_submit is a FILING, counted
// per walk. Each walk also reads the learn's own network backstop (filingBackstop.ts) and reports
// what it held, so a run says whether a filing reached the server or was held in the browser.
// Every name and value is invented (zzfixture).
//
//   npx tsx portal-bot/src/adapters/learnNeverPressesHiddenOrMidflowSubmit.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
const SMOKE_ARTIFACTS = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "learn-never-submit-"));
process.env.REPLAY_CAPTURE_DIR = SMOKE_ARTIFACTS;
process.env.REPLAY_RUN_DIR = nodePath.join(SMOKE_ARTIFACTS, "runs");
process.env.PORTAL_SCREENSHOT_DIR = nodePath.join(SMOKE_ARTIFACTS, "screenshots");
process.env.ENTRY_SETTLE_MS = "0";
process.env.PORTAL_VISION_PLAN = "0";
delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
import http from "node:http";
import { chromium, type Browser } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanResponse } from "./autoLearnAdapter";
import { backstopFor, type BackstopAbort } from "../filingBackstop";
import type { RecipeStep } from "../../../shared/src/types";

const results: Array<{ label: string; ok: boolean; detail: string }> = [];
const check = (label: string, ok: boolean, detail = ""): void => { results.push({ label, ok, detail: detail.slice(0, 1800) }); };

// ------------------------------------------------------------------------------------------
// The synthetic site
// ------------------------------------------------------------------------------------------
const HOST = "permits.zzfixture.gov";
type Sc = "hidden_submit" | "hidden_proceed" | "midsubmit" | "continue_app";

const shell = (o: { title: string; content: string; nav?: string; script?: string }): string => `<!doctype html><html><head><meta charset="utf-8"><title>ZZ Permit Center</title>
<style>body{font:14px sans-serif;margin:0} .main{padding:8px}
.btn{display:inline-block;padding:4px 10px;border:1px solid #888;background:#eee;cursor:pointer}
#stepNav{display:flex;gap:12px;margin:16px 0}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;z-index:1055} .modal.show{display:block}
.modal-dialog{margin:80px auto;width:420px;background:#fff;border:1px solid #333;padding:8px;position:relative;z-index:1056}
.modal-backdrop{position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;opacity:.5;z-index:1050}</style>
</head><body>
<header><h1>ZZ Permit Center</h1></header>
<form id="wizard_form" action="/a/w" method="POST" enctype="multipart/form-data" accept-charset="UTF-8">
 <div class="main"><h2 class="page-title">${o.title}</h2>
  <div id="stepArea">${o.content}</div>
  <div id="stepNav">${o.nav ?? ""}</div>
 </div>
</form>
<footer><p>Questions? Call 555-0100.</p></footer>
${o.script ?? ""}
</body></html>`;
const reviewPage = (): string => shell({
  title: "Check your application",
  content: `<p>Review your application before you submit it. Once submitted it cannot be changed.</p><table><tr><th>Applicant</th><td>on file</td></tr></table>`,
  nav: `<button type="submit" name="nav_prev" value="1" class="btn">Previous</button> <button type="submit" name="nav_submit" value="1" class="btn btn-primary">Submit Application</button>`,
});

// Next opens a modal "Are you sure?"; its "Yes, …" posts the form with nav_submit — a FILING —
// whether the button reads "Yes, submit" or (hidden_proceed) "Yes, continue".
const confirmPage = (kind: "continue" | "submit"): string => shell({
  title: "Roof details",
  content: `<p>Describe the roof the array is mounted on.</p>
<div class="form-group"><label for="roof_mat">Roof material *</label> <select id="roof_mat" name="roof_mat" required><option value="">-- Select --</option><option value="comp">Composition shingle</option><option value="metal">Metal</option><option value="tile">Tile</option></select></div>
<input type="hidden" name="nav_submit" id="navField" value="" disabled>
<div class="modal fade" id="confirmModal" tabindex="-1" aria-labelledby="cmTitle" aria-hidden="true">
 <div class="modal-dialog"><div class="modal-content">
  <div class="modal-header"><h5 class="modal-title" id="cmTitle">Please confirm</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close">×</button></div>
  <div class="modal-body"><p>${kind === "submit"
    ? "Are you sure you want to submit your application? Once it is submitted it cannot be changed."
    : "Are you sure you want to continue? You will not be able to change the roof details after this step."}</p></div>
  <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button> <button type="button" class="btn btn-primary" id="cmYes">${kind === "submit" ? "Yes, submit" : "Yes, continue"}</button></div>
 </div></div>
</div>`,
  nav: `<button type="submit" name="nav_prev" value="1" class="btn" formnovalidate>Previous</button> <button type="button" class="btn btn-primary" id="btnNext">Next</button>`,
  script: `<script>
(function () {
  var m = document.getElementById('confirmModal'); var bd = null;
  function show() {
    m.classList.add('show'); m.style.display = 'block'; m.removeAttribute('aria-hidden'); m.setAttribute('aria-modal', 'true'); m.setAttribute('role', 'dialog');
    bd = document.createElement('div'); bd.className = 'modal-backdrop fade show'; document.body.appendChild(bd); document.body.classList.add('modal-open');
  }
  // Instrumentation only: which control answered the dialog, whether the click was trusted, and
  // whether the dialog was shown at the time.
  function log(ev, e) { try { var x = new XMLHttpRequest(); x.open('GET', '/a/log?ev=' + ev + '&trusted=' + (e && e.isTrusted ? 1 : 0) + '&shown=' + (m.classList.contains('show') ? 1 : 0), false); x.send(); } catch (err) {} }
  function hide(e, why) {
    log('close-' + (why || 'x'), e);
    m.classList.remove('show'); m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); m.removeAttribute('aria-modal'); m.removeAttribute('role');
    if (bd) { bd.parentNode.removeChild(bd); bd = null; } document.body.classList.remove('modal-open');
  }
  document.getElementById('btnNext').addEventListener('click', function () {
    var f = document.getElementById('wizard_form'); if (!f.reportValidity()) return; show();
  });
  m.querySelectorAll('[data-bs-dismiss="modal"]').forEach(function (b) { b.addEventListener('click', function (e) { hide(e, b.textContent.trim() === 'Cancel' ? 'cancel' : 'x'); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && m.classList.contains('show')) hide(e, 'escape'); });
  document.getElementById('cmYes').addEventListener('click', function (e) {
    log('yes', e);
    var nf = document.getElementById('navField'); nf.disabled = false; nf.value = '1'; document.getElementById('wizard_form').submit();
  });
})();
</script>`,
});

const pagesOf = (sc: Sc): string[] => {
  switch (sc) {
    case "hidden_submit": return [confirmPage("submit"), reviewPage()];
    case "hidden_proceed": return [confirmPage("continue"), reviewPage()];
    // Control: a fillable page whose VISIBLE forward control reads "Continue Application" (an advance).
    case "continue_app": return [shell({
      title: "Applicant",
      content: `<p>Who is applying.</p><div class="form-group"><label for="app_phone">Applicant phone *</label> <input id="app_phone" name="app_phone" type="tel" required></div>`,
      nav: `<button type="submit" name="nav_next" value="1" class="btn btn-primary" id="btnContinue">Continue Application</button>`,
    }), reviewPage()];
    // A fillable page (not the review step) whose only forward control is a VISIBLE "Submit" that files.
    case "midsubmit": return [shell({
      title: "Applicant",
      content: `<p>Who is applying.</p><div class="form-group"><label for="app_phone">Applicant phone *</label> <input id="app_phone" name="app_phone" type="tel" required></div>`,
      nav: `<button type="submit" name="nav_submit" value="1" class="btn btn-primary" id="btnSubmit">Submit</button>`,
    }), reviewPage()];
  }
};

// ------------------------------------------------------------------------------------------
// The server (state per walk in cookies). A POST to /a/w carrying nav_submit is a FILING.
// ------------------------------------------------------------------------------------------
interface Hit { walk: string; method: string; path: string; query: string; values: Record<string, string> }
const hits: Hit[] = [];
const cookieOf = (q: http.IncomingMessage, name: string): string => new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_]+)`).exec(String(q.headers.cookie || ""))?.[1] ?? "";
const parseBody = (ct: string, body: Buffer): Record<string, string> => {
  const values: Record<string, string> = {};
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (/multipart\/form-data/i.test(ct) && bm) {
    const boundary = `--${bm[1] || bm[2]}`;
    for (const part of body.toString("latin1").split(boundary)) {
      const hm = /^\r\nContent-Disposition: form-data; name="([^"]*)"(?:; filename="([^"]*)")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/i.exec(part);
      if (hm && hm[2] === undefined) values[hm[1]] = hm[3];
    }
  } else if (/x-www-form-urlencoded/i.test(ct)) {
    for (const kv of body.toString("utf8").split("&").filter(Boolean)) {
      const [k, v = ""] = kv.split("=");
      values[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
    }
  }
  return values;
};
const server = http.createServer((q, r) => {
  const chunks: Buffer[] = [];
  q.on("data", (c: Buffer) => chunks.push(c));
  q.on("end", () => {
    const url = new URL(q.url || "/", "http://x");
    const method = String(q.method || "GET").toUpperCase();
    const walk = cookieOf(q, "walk");
    const sc = (cookieOf(q, "sc") || "continue_app") as Sc;
    const values = method === "GET" ? {} : parseBody(String(q.headers["content-type"] || ""), Buffer.concat(chunks));
    hits.push({ walk, method, path: url.pathname, query: url.search, values });
    const send = (html: string, headers: Record<string, string> = {}): void => { r.writeHead(200, { "Content-Type": "text/html", ...headers }); r.end(html); };
    if (url.pathname === "/a/w") {
      const pages = pagesOf(sc);
      let n = Number(cookieOf(q, "wstep") || "1") || 1;
      if (method === "GET") n = 1;
      else if (values.nav_submit) return send(shell({ title: "Filed", content: `<p>FILED BY THE FIXTURE — automation must never reach this.</p>` }));
      else if (values.nav_next) n = Math.min(pages.length, n + 1);
      else if ("nav_prev" in values) n = Math.max(1, n - 1);
      return send(pages[n - 1], { "Set-Cookie": `wstep=${n}; Path=/` });
    }
    return send(`<!doctype html><html><head><title>Elsewhere</title></head><body><h1>Elsewhere</h1></body></html>`);
  });
});
await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
const port = (server.address() as { port: number }).port;
const BASE = `http://${HOST}:${port}`;
const ENTRY = `${BASE}/a/w?begin=1`;
const browser: Browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
const PROJECT = { projectAddress: "12 ZZ Test Way, Testville, ZZ, 00001", street: "12 ZZ Test Way", city: "Testville", state: "ZZ", zip: "00001", homeownerName: "ZZ Test Owner", permitType: "electrical", systemSizeKw: 7.2 };

// ------------------------------------------------------------------------------------------
// Planners. Ordinary: names "Next", and a dialog's "Yes, …" only when the page TEXT shows the dialog.
// Blind: names a dialog's "Yes, …" whenever the scrape offers one (a CLOSED modal's too), and with no
// Next names a mid-flow "Submit" — used only to prove the learner's own gates.
// ------------------------------------------------------------------------------------------
const makePlanner = (blind: boolean): LearnPlanner => async (req): Promise<LearnPlanResponse> => {
  const lab = (i: number): string => String(req.fields[i]?.label ?? "").replace(/\s+/g, " ").trim();
  const submit = req.fields.findIndex((f, i) => f.fieldType === "button" && /^submit application$/i.test(lab(i)));
  if (submit >= 0) return { fills: [], atReview: true, finalSubmitSelectorIndex: submit };
  const done = new Set((req.alreadyFilledLabels ?? []).map((l) => String(l).trim()));
  const fills: LearnPlanResponse["fills"] = [];
  req.fields.forEach((f, i) => {
    const l = lab(i);
    if (done.has(l) || f.fieldType === "button" || f.fieldType === "file") return;
    if (/roof material/i.test(l)) fills.push({ selectorIndex: i, value: "Composition shingle" });
    else if (/applicant phone/i.test(l)) fills.push({ selectorIndex: i, value: "5550100", field: "phone" });
  });
  const buttons = req.fields.map((f, i) => ({ f, i, l: lab(i) })).filter((x) => x.f.fieldType === "button");
  const dialogShown = /are you sure/i.test(String(req.bodyText ?? ""));
  const yes = blind || dialogShown ? buttons.find((x) => /^yes\b/i.test(x.l)) : undefined;
  const next = buttons.find((x) => /^(next|continue|continue application)$/i.test(x.l));
  const sub = blind ? buttons.find((x) => /^submit$/i.test(x.l)) : undefined;
  const adv = yes ?? next ?? sub;
  return { fills, atReview: false, ...(adv ? { advanceSelectorIndex: adv.i } : {}) };
};

// ------------------------------------------------------------------------------------------
// The learn walk
// ------------------------------------------------------------------------------------------
interface Walk {
  ok: boolean; message: string; stopReason?: string; reachedReview?: boolean; secs: number;
  steps: RecipeStep[]; plannerAdvances: string[]; events: Array<Record<string, unknown>>;
  mine: Hit[]; navPosts: Hit[]; filed: number; pageLog: string[];
  backstopSeen: boolean; aborts: BackstopAbort[];
}
let seq = 0;
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((res) => { const t = setTimeout(() => res(fallback), ms); (t as { unref?: () => void }).unref?.(); })]);

const learnWalk = async (sc: Sc, plan: LearnPlanner): Promise<Walk> => {
  const id = `w${++seq}`;
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(10_000);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  await ctx.addCookies([{ name: "walk", value: id, url: BASE }, { name: "sc", value: sc, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(ENTRY);
  const plannerAdvances: string[] = [];
  const spy: LearnPlanner = async (req) => {
    const res = await plan(req);
    if (res.advanceSelectorIndex !== undefined) plannerAdvances.push(String(req.fields[res.advanceSelectorIndex]?.label ?? ""));
    return res;
  };
  const a = new AutoLearnAdapter("ZZ Learn Gate", spy, { maxPages: 6, budgetMs: 150_000, docsByType: {} } as never);
  (a as unknown as { page: unknown }).page = page;
  const events: Array<Record<string, unknown>> = [];
  const holder = a as unknown as { debug?: { event: (e: Record<string, unknown>) => void } | null };
  if (holder.debug && typeof holder.debug.event === "function") {
    const orig = holder.debug.event.bind(holder.debug);
    holder.debug.event = (e) => { events.push(e); orig(e); };
  } else holder.debug = { event: (e) => { events.push(e); } };
  // The learn's own network backstop: was it installed, and what did it hold? (read-only probe;
  // the reference is kept so its aborts can be read after the learn uninstalls it)
  const seenBackstops = new Set<ReturnType<typeof backstopFor>>();
  const probe = setInterval(() => { const b = backstopFor(page); if (b) seenBackstops.add(b); }, 100);
  const t0 = Date.now();
  let r: Record<string, unknown>;
  try {
    r = await withTimeout(a.learn({ portalUrl: ENTRY } as never, PROJECT as never) as unknown as Promise<Record<string, unknown>>,
      200_000, { ok: false, message: "smoke: learn exceeded 200 s", steps: [] });
  } catch (e) { r = { ok: false, message: `threw: ${String(e)}`, steps: [] }; }
  clearInterval(probe);
  { const b = backstopFor(page); if (b) seenBackstops.add(b); }
  await new Promise((res) => setTimeout(res, 600)); // a late request lands
  await ctx.close().catch(() => null);
  const mine = hits.filter((h) => h.walk === id);
  const aborts = [...seenBackstops].flatMap((b) => (b ? [...b.aborts] : []));
  return {
    ok: r.ok === true, message: String(r.message ?? ""), stopReason: r.stopReason as string | undefined, reachedReview: r.reachedReview as boolean | undefined,
    secs: Math.round((Date.now() - t0) / 1000), steps: Array.isArray(r.steps) ? r.steps as RecipeStep[] : [], plannerAdvances, events,
    mine,
    navPosts: mine.filter((h) => h.path === "/a/w" && h.method === "POST"),
    filed: mine.filter((h) => h.path === "/a/w" && h.method === "POST" && !!h.values.nav_submit).length,
    pageLog: mine.filter((h) => h.path === "/a/log").map((h) => h.query),
    backstopSeen: seenBackstops.size > 0, aborts,
  };
};
const brief = (w: Walk): string => JSON.stringify({
  ok: w.ok, stop: w.stopReason, review: w.reachedReview, secs: w.secs, message: w.message.slice(0, 300),
  FILED_AT_SERVER: w.filed, nav: w.navPosts.map((h) => JSON.stringify(h.values)), pageLog: w.pageLog,
  advances: w.plannerAdvances, backstopInstalled: w.backstopSeen,
  backstopAborts: w.aborts.map((x) => `${x.rule} ${x.method} ${x.where} (${String(x.why).slice(0, 80)})`),
  steps: w.steps.map((s) => `${s.action}:${s.note ?? ""}`).slice(-8),
  events: w.events.filter((e) => /^(advance|dialog|modal|click)/.test(String(e.type))).map((e) => JSON.stringify(e).slice(0, 200)).slice(-8),
});
const clickedSubmit = (w: Walk): boolean => w.steps.some((s) => s.action === "click" && /submit/i.test(String(s.note ?? "")));

// ------------------------------------------------------------------------------------------
// 1. A CLOSED modal's "Yes, submit" named as the advance (blind planner)
// ------------------------------------------------------------------------------------------
const hiddenW = await learnWalk("hidden_submit", makePlanner(true));
console.log(`  walk hidden_submit: ${brief(hiddenW)}`);
check("hidden_submit EXERCISED: the blind planner named the closed modal's \"Yes, submit\" as the advance (else the refusal is vacuous)",
  hiddenW.plannerAdvances.some((l) => /^yes, submit$/i.test(l.trim())), brief(hiddenW));
check("hidden_submit: no filing request reaches the server (filed = 0), and no step records a click on it",
  hiddenW.filed === 0 && !clickedSubmit(hiddenW), brief(hiddenW));
check("hidden_submit: the page's \"Yes\" handler never ran (no force / dispatch click on an invisible control)",
  !hiddenW.pageLog.some((l) => /ev=yes/.test(l)), brief(hiddenW));
check("hidden_submit: the walk does not end as a success", !hiddenW.ok, brief(hiddenW));

// ------------------------------------------------------------------------------------------
// 1b. A CLOSED modal's "Yes, continue" (no submit wording) whose handler files (blind planner):
//     only the click gate can hold this one
// ------------------------------------------------------------------------------------------
const proceedW = await learnWalk("hidden_proceed", makePlanner(true));
console.log(`  walk hidden_proceed: ${brief(proceedW)}`);
check("hidden_proceed EXERCISED: the blind planner named the closed modal's \"Yes, continue\" as the advance",
  proceedW.plannerAdvances.some((l) => /^yes, continue$/i.test(l.trim())), brief(proceedW));
check("hidden_proceed: the page's \"Yes\" handler never ran while the modal was closed (no force / dispatch click on an invisible control)",
  !proceedW.pageLog.some((l) => /ev=yes/.test(l) && /shown=0/.test(l)), brief(proceedW));
check("hidden_proceed: no filing request reaches the server (filed = 0)", proceedW.filed === 0, brief(proceedW));

// ------------------------------------------------------------------------------------------
// 2. A VISIBLE mid-flow "Submit" on a fillable, non-review page named as the advance (blind planner)
// ------------------------------------------------------------------------------------------
const midW = await learnWalk("midsubmit", makePlanner(true));
console.log(`  walk midsubmit: ${brief(midW)}`);
check("midsubmit EXERCISED: the blind planner named the visible mid-flow \"Submit\" as the advance",
  midW.plannerAdvances.some((l) => /^submit$/i.test(l.trim())), brief(midW));
check("midsubmit: no filing request reaches the server (filed = 0), not recorded as a click, the run stops",
  midW.filed === 0 && !clickedSubmit(midW) && !midW.ok, brief(midW));
check("midsubmit: the submit-worded advance was refused in the learn (not merely held by the backstop): no backstop abort of a filing POST",
  !midW.aborts.some((x) => x.method === "POST" && /\/a\/w$/.test(x.where)), brief(midW));

// ------------------------------------------------------------------------------------------
// 3. Control (no over-refusal): a VISIBLE "Continue Application" on a fillable page is still an advance
// ------------------------------------------------------------------------------------------
const ctlW = await learnWalk("continue_app", makePlanner(false));
console.log(`  walk continue_app (control): ${brief(ctlW)}`);
const ctlPosted = ctlW.navPosts.filter((h) => !!h.values.nav_next);
check("control: \"Continue Application\" is pressed as the advance, the step posts (phone typed), the review page is reached; never filed",
  ctlPosted.length === 1 && ctlPosted[0].values.app_phone === "5550100" && ctlW.reachedReview === true && ctlW.filed === 0, brief(ctlW));

await browser.close();
await new Promise<void>((res) => server.close(() => res()));

console.log("\nlearnNeverPressesHiddenOrMidflowSubmit.dom.smoke");
let failures = 0;
for (const r of results) {
  if (r.ok) console.log(`  ok   - ${r.label}`);
  else { failures++; console.error(`  FAIL - ${r.label}\n         ${r.detail}`); }
}
if (failures) { console.error(`\n${failures}/${results.length} learnNeverPressesHiddenOrMidflowSubmit.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log(`\n${results.length}/${results.length} learnNeverPressesHiddenOrMidflowSubmit.dom.smoke checks passed.`);
process.exit(0);
