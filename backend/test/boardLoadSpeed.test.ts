// OPENING A JOB WAS SLOW, AND THE BOARD KEPT THE SERVER BUSY (staff report, 2026-11-21).
//
// Measured on a 300-job scratch board (synthetic jobs through the real creation path and chain):
//   - every card the submit gate could still overrule asks GET /api/projects/:id/next-step, and
//     each read cost ~350 ms of blocking server work — two-thirds of it projectEvidence rebuilding
//     its sources (scrubbing the whole plan-set text with redactSecretValues) once per QUESTION;
//   - the board's three-at-a-time gate reads kept running on the project page, so opening a job
//     while the board loaded took 21 s (its ~30 reads queued behind cards nobody could see);
//   - every server event reloaded the whole board in every open dashboard, and the open job's page
//     twice, whichever project the event was about.
// After: ~55 ms a gate read, the job opens in ~1.4 s, the board's checks finish in ~20 s, not ~112 s.
//
// This pins the behaviour the speed-up must not change:
//   1. the evidence sources are rebuilt whenever ANY input changes — a field, a re-parsed plan set
//      edited in place, a new account number (a stale scrub would leak or hide evidence);
//   2. the board's gate reads pause on the project page and resume on a list page;
//   3. a burst of events refreshes once, reopens the open job only when an event may concern it,
//      and never navigates someone off the board.
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRecord } from "../../shared/src/types";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const { allProjectEvidenceText, evidenceForTopic } = await import("../src/projectEvidence");

// ── 1. The evidence memo never serves a stale build ─────────────────────────────────────────
{
  const job = (over: Partial<ProjectRecord> & { parserSnapshot?: Record<string, unknown> } = {}): ProjectRecord => ({
    id: "speed-1", utility: "Example Power", ahj: "Example City", interconnectionMethod: "Load-side breaker",
    parserConfidenceSummary: "", accountNumber: "8812345678", meterNumber: "",
    parserSnapshot: { planSetExtractedText: "SITE PLAN\nAccount 8812345678 shown on the bill.\nROOF PLAN" },
    ...over,
  } as unknown as ProjectRecord);

  const a = job();
  const first = allProjectEvidenceText(a);
  check("the account number is scrubbed from the plan-set text", !first.includes("8812345678") && first.includes("[redacted]"), first);
  check("a second read of the same job gives the same text", allProjectEvidenceText(a) === first);

  // A new account number on the SAME object: the old value is no longer a secret, the new one is.
  a.accountNumber = "7700112233";
  (a.parserSnapshot as Record<string, unknown>).planSetExtractedText = "SITE PLAN\nAccount 7700112233 shown.\nRATED 8812345678";
  const second = allProjectEvidenceText(a);
  check("MUST-PASS: a changed account number is scrubbed (the memo rebuilt)", !second.includes("7700112233"), second);
  check("…and the old value, no longer a secret, is no longer scrubbed", second.includes("8812345678"), second);

  // The plan-set text edited IN PLACE on the same snapshot object (no new object, same id).
  const b = job({ parserSnapshot: { planSetExtractedText: "SITE PLAN only" } });
  check("no SLD evidence before the one-line is added", evidenceForTopic(b, "sld").present === false);
  (b.parserSnapshot as Record<string, unknown>).planSetExtractedText = "SITE PLAN\nSINGLE LINE DIAGRAM E-1";
  check("MUST-PASS: text edited in place on the same snapshot is read (no stale evidence)", evidenceForTopic(b, "sld").present === true);

  // Two different jobs never share sources, even with one id (a fresh read of a changed row).
  const c1 = job({ id: "speed-2", parserSnapshot: { planSetExtractedText: "FIRE ACCESS PATHWAY 36 in" } });
  const c2 = job({ id: "speed-2", parserSnapshot: { planSetExtractedText: "nothing here" } });
  check("the same id with different text gives different evidence",
    evidenceForTopic(c1, "firePathway").present === true && evidenceForTopic(c2, "firePathway").present === false);
  // A changed top-level field (not in the snapshot) is read too.
  const d = job({ id: "speed-3", interconnectionMethod: "Supply-side tap" });
  const before = allProjectEvidenceText(d);
  d.interconnectionMethod = "Line-side connection";
  check("a changed project field is read", allProjectEvidenceText(d) !== before && allProjectEvidenceText(d).includes("Line-side connection"));
}

// ── Lifting real functions from dashboard.js (boardGateTruth's lift) ───────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const lift = (name: string): string => {
  const re = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = m[0].startsWith("const");
  let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  if (isConst && !"{[(".includes(dashboard[i])) { const semi = dashboard.indexOf(";\n", i); return dashboard.slice(m.index, semi + 1); }
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i) + (isConst ? ";" : "");
};
const build = (names: string[], prelude: string, state: Record<string, unknown>, stubs: Record<string, unknown>): Record<string, any> =>
  // eslint-disable-next-line no-new-func
  new Function("state", ...Object.keys(stubs), `${prelude}\n${names.map(lift).join("\n\n")}\nreturn { ${names.join(", ")} };`)(state, ...Object.values(stubs));

// ── 2. The board's gate reads pause on the project page ─────────────────────────────────────
{
  const names = ["NEXT_STEP_CHIP", "GATE_ANSWER_TTL_MS", "gateStampFor", "compactGateAnswer", "rowNeedsGateAnswer", "hydrateBoardGates"];
  const prelude = "let gateHydrationRunning = false; let gateHydrationAgain = false;";
  const row = (id: string) => ({ id, updatedAt: "2026-11-21T00:00:00Z", nextStep: { key: "ready_to_stage", gateChecked: false, gateCanOverrule: true } });
  const state: Record<string, unknown> = { page: "project", gateAnswers: {}, projects: Array.from({ length: 6 }, (_, i) => row(`p${i}`)) };
  const asked: string[] = [];
  const api = async (url: string) => {
    asked.push(url);
    await new Promise((r) => setTimeout(r, 2));
    return { nextStep: { key: "gate_blocked", gateChecked: true } };
  };
  const lib = build(names, prelude, state, { api, scheduleBoardRerender: () => {} });
  await lib.hydrateBoardGates();
  check("MUST-PASS: no card is asked while the project page is open", asked.length === 0, asked.join(","));
  state.page = "dashboard";
  await lib.hydrateBoardGates();
  check("back on the board, every card is asked once", asked.length === 6 && new Set(asked).size === 6, asked.join(","));
}

// ── 3. One refresh per burst of events; the open job reloads only when it may be concerned ─────
{
  const names = ["SSE_REFRESH_DELAY_MS", "sseRefresh", "scheduleSseRefresh"];
  const run = async (page: string, openId: string | null, events: Array<string | null>) => {
    const state: Record<string, unknown> = { page, selectedProjectId: openId };
    const calls = { load: [] as unknown[], select: [] as string[] };
    const stubs = {
      loadProjects: async (opts: unknown) => { calls.load.push(opts); },
      selectProject: async (id: string) => { calls.select.push(id); },
      setTimeout: (fn: () => void) => globalThis.setTimeout(fn, 1),
    };
    const lib = build(names, "", state, stubs);
    for (const e of events) lib.scheduleSseRefresh(e);
    await new Promise((r) => globalThis.setTimeout(r, 30));
    return calls;
  };
  const burst = await run("project", "open", ["a", "b", "a", "c", "d"]);
  check("MUST-PASS: five events in a burst reload the board ONCE", burst.load.length === 1, JSON.stringify(burst.load));
  check("…without the board reload reopening the job itself", JSON.stringify(burst.load[0]) === JSON.stringify({ reselect: false }), JSON.stringify(burst.load[0]));
  check("events about OTHER jobs do not reload the open job", burst.select.length === 0, burst.select.join(","));
  const mine = await run("project", "open", ["a", "open", "b"]);
  check("an event naming the open job reloads it once", mine.select.length === 1 && mine.select[0] === "open", mine.select.join(","));
  const unnamed = await run("project", "open", [null]);
  check("an event naming no job (an inbox poll) reloads the open job too — it may concern it", unnamed.select.length === 1);
  const board = await run("dashboard", "open", ["open"]);
  check("MUST-PASS: on the board, an event about the last-opened job never navigates into it", board.select.length === 0 && board.load.length === 1);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nboardLoadSpeed: all checks passed");
