// A PERSON-VERIFIED RECORD TYPE IS THE WORK-ITEM PICK, NOT THE PLANNER'S (#166).
//
// Watched City of Bend learn (2026-11-12): CityView's "Work Items" page listed both "Prescriptive
// photovoltaic systems" — the job's person-verified process row names exactly this — and
// "Renewable energy up to 25KVA". The planner ticked the Renewable one and the run went on to file
// the wrong work item. Nothing refused it: both are electrical, both solar, and the verified name
// had never reached the learner.
//
// This drives the REAL AutoLearnAdapter.learn() against a local work-item page with a planner that
// always picks the decoy, and checks the four fixtures the issue asks for:
//   (a) the verified label offered beside the decoy → the verified box is ticked by the walk, by
//       label, before the planner is asked; the decoy stays untouched and the planner's pick of it
//       is refused ("a person-verified record type is offered on this page");
//   (b) the verified label absent → one record_type_verified_not_offered event, the planner is
//       told the name, and its pick stands; the result names the gap (recordTypeNotOffered);
//   (c) a SEEDED record type → no deterministic tick, the planner's pick stands (hard rule 3);
//   (d) the match survives case / punctuation / a "permit" suffix — (a)'s target is spelled
//       "PRESCRIPTIVE Photovoltaic-Systems Permit".
//
//   MUST PASS    - (a), (b), (d) go red with the pass removed; (c) goes red with the `verified` gate
//                  removed from verifiedRecordType() (a seeded row would then be ticked).
//   MUST EXCLUDE - with no record type on file nothing changes: the planner's pick stands, no
//                  record_type_* event.
//
//   npx tsx portal-bot/src/adapters/verifiedRecordType.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { LearnTargetRecordType, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const VERIFIED = "Prescriptive photovoltaic systems";
const DECOY = "Renewable energy up to 25KVA";

/** A CityView-shaped work-item list: a fieldset of checkboxes under one heading, a comment box, a
 *  Next button. `withVerified` = whether the verified label is offered at all. */
const pageHtml = (withVerified: boolean): string => `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Work Items</h2>
  <p>Select the work items for this permit application.</p>
  <fieldset><legend>Electrical</legend>
    <div><input type="checkbox" id="wi1"><label for="wi1">Service upgrade</label></div>
    ${withVerified ? `<div><input type="checkbox" id="wi2"><label for="wi2">${VERIFIED}</label></div>` : ""}
    <div><input type="checkbox" id="wi3"><label for="wi3">${DECOY}</label></div>
    <div><input type="checkbox" id="wi4"><label for="wi4">Electrical generator installation</label></div>
  </fieldset>
  <label for="comments">Comments</label><input id="comments" type="text">
  <button type="button" id="next">Next</button>
</body></html>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(pageHtml(!/absent/.test(String(q.url ?? ""))));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();

interface Run {
  steps: RecipeStep[];
  events: Array<Record<string, unknown>>;
  requests: LearnPlanRequest[];
  checked: Record<string, boolean>;
  result: Record<string, unknown>;
}

/** One learn on the page, with a planner that always ticks the decoy on its first look. */
async function run(opts: { path: string; target: LearnTargetRecordType | null }): Promise<Run> {
  const url = `http://127.0.0.1:${port}/${opts.path}`;
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page: Page = await ctx.newPage();
  await page.goto(url);
  const requests: LearnPlanRequest[] = [];
  let asked = 0;
  const planner: LearnPlanner = async (req) => {
    requests.push(req);
    asked++;
    if (asked > 1) return { fills: [], atReview: true };
    const decoy = req.fields.findIndex((f) => String(f.label ?? "") === DECOY);
    const comments = req.fields.findIndex((f) => String(f.label ?? "") === "Comments");
    return {
      fills: [
        ...(decoy >= 0 ? [{ selectorIndex: decoy, value: "true" }] : []),
        ...(comments >= 0 ? [{ selectorIndex: comments, value: "solar" }] : []),
      ],
      atReview: false,
    };
  };
  const adapter = new AutoLearnAdapter("Work Items Test", planner, { maxPages: 2, targetRecordType: opts.target });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).page = page;
  const events: Array<Record<string, unknown>> = [];
  const holder = adapter as unknown as { debug?: { event: (e: Record<string, unknown>) => void } };
  if (holder.debug && typeof holder.debug.event === "function") {
    const orig = holder.debug.event.bind(holder.debug);
    holder.debug.event = (e) => { events.push(e); orig(e); };
  } else {
    holder.debug = { event: (e) => { events.push(e); } };
  }
  const result = await adapter.learn(
    { portalUrl: url } as never,
    { projectAddress: "1 Test St, Bendville, OR, 97700", city: "Bendville", state: "OR", zip: "97700", homeownerName: "T", permitType: "electrical" } as never,
  ) as unknown as Record<string, unknown>;
  const checked = await page.evaluate(() => {
    const out: Record<string, boolean> = {};
    for (const cb of Array.from(document.querySelectorAll("input[type=checkbox]")) as HTMLInputElement[]) {
      const lab = document.querySelector(`label[for="${cb.id}"]`) as HTMLElement | null;
      out[(lab?.innerText || cb.id).trim()] = cb.checked;
    }
    return out;
  });
  await ctx.close();
  return { steps: (result.steps as RecipeStep[]) ?? [], events, requests, checked, result };
}

const typeEvents = (r: Run): Array<Record<string, unknown>> => r.events.filter((e) => /^record_type_/.test(String(e.type)));
const checkSteps = (r: Run, label: string): RecipeStep[] =>
  r.steps.filter((s) => s.action === "check" && (String(s.selector?.label ?? "") === label || String(s.note ?? "").includes(label)));

// ── (a) + (d): the verified label is offered, spelled differently from the page ──────────────────
{
  const r = await run({ path: "offered", target: { value: "PRESCRIPTIVE Photovoltaic-Systems Permit", verified: true } });
  console.log(`   (a) checked: ${JSON.stringify(r.checked)}; events: ${JSON.stringify(typeEvents(r))}`);
  check("(a) the verified work item is ticked on the page", r.checked[VERIFIED] === true, JSON.stringify(r.checked));
  check("(a) the decoy is untouched", r.checked[DECOY] === false, JSON.stringify(r.checked));
  const vs = checkSteps(r, VERIFIED);
  check("(a) ONE check step is recorded for it, BY LABEL, with the verified note",
    vs.length === 1 && String(vs[0].selector?.label ?? "") === VERIFIED && vs[0].note === `record type (verified): ${VERIFIED}`,
    JSON.stringify(vs));
  check("(a) no step is recorded for the decoy", checkSteps(r, DECOY).length === 0, JSON.stringify(checkSteps(r, DECOY)));
  const pick = r.events.find((e) => e.type === "record_type_verified_pick");
  check("(a) event record_type_verified_pick {label, offeredCount}",
    Boolean(pick) && pick!.label === VERIFIED && pick!.offeredCount === 4, JSON.stringify(pick));
  const refused = r.events.filter((e) => e.type === "record_type_refused");
  check("(a) the planner's pick of the decoy is refused with the new reason",
    refused.length >= 1 && refused.every((e) => e.label === DECOY && e.why === "a person-verified record type is offered on this page"),
    JSON.stringify(refused));
  check("(a) the planner was told it is settled (alreadyFilledLabels carries the verified label)",
    r.requests.length > 0 && r.requests[0].alreadyFilledLabels.includes(VERIFIED),
    JSON.stringify(r.requests[0]?.alreadyFilledLabels));
  check("(a) no not-offered event, no gap in the result",
    !r.events.some((e) => e.type === "record_type_verified_not_offered") && r.result.recordTypeNotOffered === undefined,
    JSON.stringify(typeEvents(r)));
  check("(d) the match folded case, punctuation and the 'permit' suffix (the target was not spelled as the page)",
    r.checked[VERIFIED] === true, "covered by (a) with the differently-spelled target");
  check("(a) the planner's other fill still lands (the text box)", r.steps.some((s) => s.action === "fill" && String(s.selector?.label ?? "") === "Comments"),
    JSON.stringify(r.steps));
}

// ── (b): the verified label is NOT offered ───────────────────────────────────────────────────────
{
  const WANT = "Solar PV combination permit";
  const r = await run({ path: "absent", target: { value: WANT, verified: true } });
  console.log(`   (b) checked: ${JSON.stringify(r.checked)}; events: ${JSON.stringify(typeEvents(r))}`);
  const no = r.events.filter((e) => e.type === "record_type_verified_not_offered");
  check("(b) ONE event record_type_verified_not_offered {wanted, offered}",
    no.length === 1 && no[0].wanted === WANT && Array.isArray(no[0].offered) && (no[0].offered as string[]).includes(DECOY) && (no[0].offered as string[]).length <= 12,
    JSON.stringify(no));
  check("(b) the planner's pick stands: the decoy is ticked and recorded", r.checked[DECOY] === true && checkSteps(r, DECOY).length === 1, JSON.stringify({ checked: r.checked, steps: checkSteps(r, DECOY) }));
  check("(b) nothing was refused and nothing verified-picked", !r.events.some((e) => e.type === "record_type_refused" || e.type === "record_type_verified_pick"), JSON.stringify(typeEvents(r)));
  check("(b) the planner was given the verified name as a hint for this page",
    r.requests.length > 0 && String(r.requests[0].recoveryHint ?? "").includes(WANT), JSON.stringify(r.requests[0]?.recoveryHint));
  const gap = r.result.recordTypeNotOffered as { wanted: string; offered: string[]; ticked: string[] } | undefined;
  check("(b) the result names the gap for a person: wanted, offered, and what the walk ticked",
    Boolean(gap) && gap!.wanted === WANT && gap!.offered.includes(DECOY) && gap!.ticked.includes(DECOY), JSON.stringify(gap));
}

// ── (c): a SEEDED record type is a hint only ─────────────────────────────────────────────────────
{
  const r = await run({ path: "offered", target: { value: VERIFIED, verified: false } });
  console.log(`   (c) checked: ${JSON.stringify(r.checked)}; events: ${JSON.stringify(typeEvents(r))}`);
  check("(c) no deterministic tick of the seeded name", r.checked[VERIFIED] === false && checkSteps(r, VERIFIED).length === 0, JSON.stringify({ checked: r.checked, steps: checkSteps(r, VERIFIED) }));
  check("(c) the planner's pick stands", r.checked[DECOY] === true && checkSteps(r, DECOY).length === 1, JSON.stringify(r.checked));
  check("(c) no record_type_verified_* event, no refusal", typeEvents(r).length === 0, JSON.stringify(typeEvents(r)));
}

// ── MUST EXCLUDE: nothing on file ────────────────────────────────────────────────────────────────
{
  const r = await run({ path: "offered", target: null });
  check("MUST EXCLUDE: with no record type on file the planner's pick stands and no record_type_* event fires",
    r.checked[DECOY] === true && r.checked[VERIFIED] === false && typeEvents(r).length === 0, JSON.stringify({ checked: r.checked, events: typeEvents(r) }));
}

await browser.close();
server.close();
console.log(failures === 0 ? "verifiedRecordType.dom.smoke: PASS" : `verifiedRecordType.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
