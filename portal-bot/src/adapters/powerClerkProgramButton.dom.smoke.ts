// WHICH PACIFICORP PROGRAM A JOB OPENS (#602) — real Chromium, the real PowerClerkAdapter.openSubmission.
//
// PacifiCorp runs ONE PowerClerk tenant for both of its brands, and its Program Home shows BOTH
// "New Pacific Power Customer Generation Application" and "New Rocky Mountain Power Customer
// Generation Application". openSubmission mapped any "PacifiCorp" / "Pacific Power" spelling to the
// word "Pacific Power" with no state, so a UTAH job typed that way clicked the Pacific Power program.
// The brand now comes from the job's state (utilityIdentity.pacifiCorpBrand). A SYNTHETIC copy of the
// Program Home (no customer data, no live portal); each program link lands on its own data page:
//
//   [A] UT typed "PacifiCorp"            -> Rocky Mountain Power (Pacific Power listed FIRST)
//   [B] UT typed "Pacific Power"         -> Rocky Mountain Power (Pacific Power listed FIRST)
//   [C] UT typed "Rocky Mountain Power"  -> Rocky Mountain Power (unchanged)
//   [D] ID typed "RMP"                   -> Rocky Mountain Power
//   [E] OR typed "PacifiCorp"            -> Pacific Power (Rocky Mountain Power listed FIRST)
//   [F] OR typed "Pacific Power"         -> Pacific Power (Rocky Mountain Power listed FIRST)
//
// KILL (verified by hand): restore the stateless `/pacificorp|pacific power/i ? "Pacific Power"`
// mapping -> [A] [B] [D] FAIL (the run opens the Pacific Power program; verified 2026-11-09).
//
//   npx tsx portal-bot/src/adapters/powerClerkProgramButton.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import type { ProjectRecord } from "../../../shared/src/types";
import { PowerClerkAdapter } from "./powerClerk";

process.env.POWERCLERK_INTRO_PROBE_MS = "1500";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };

const PROGRAMS: Record<string, string> = { pp: "Pacific Power", rmp: "Rocky Mountain Power" };
const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(String(req.url), "http://x");
  res.setHeader("content-type", "text/html");
  if (url.pathname === "/home") {
    // Live markup shape: each program is an <a class="btn"> LINK. `order` picks which is listed first,
    // so a run that takes "the first New … Application" is caught either way.
    const order = url.searchParams.get("first") === "rmp" ? ["rmp", "pp"] : ["pp", "rmp"];
    res.end(html(`<h1>Program Home</h1>${order.map((k) =>
      `<p><a class="btn" href="/${k}/p1">New ${PROGRAMS[k]} Customer Generation Application</a></p>`).join("")}`));
    return;
  }
  const m = /^\/(pp|rmp)\/p1$/.exec(url.pathname);
  if (m) {
    res.end(html(`<h1>${PROGRAMS[m[1]]} Customer Generation</h1><h2>Preparer Information</h2><input placeholder="Company"><input placeholder="Email">`));
    return;
  }
  res.statusCode = 404; res.end("nope");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch();
const project = (state: string, utility: string): ProjectRecord => ({
  id: "program-button-smoke", clientId: "client-1", homeownerName: "", projectAddress: "", city: "", state, zip: "",
  ahj: "Testville", utility, accountNumber: "", meterNumber: "", parserSnapshot: {},
} as unknown as ProjectRecord);

const openFrom = async (first: "pp" | "rmp", proj: ProjectRecord): Promise<{ ok: boolean; message: string; program: string }> => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${origin}/home?first=${first}`);
  const adapter = new PowerClerkAdapter();
  (adapter as unknown as { page: unknown }).page = p;
  const result = await Promise.race([
    adapter.openSubmission(proj),
    new Promise<{ ok: boolean; message: string }>((r) => setTimeout(() => r({ ok: false, message: "TIMED OUT" }), 45_000)),
  ]);
  const program = (/\/(pp|rmp)\/p1$/.exec(p.url()) || [])[1] || `(still on ${p.url()})`;
  await ctx.close();
  return { ...result, program };
};

try {
  const cases: Array<[string, "pp" | "rmp", string, string, "pp" | "rmp"]> = [
    ["[A] UT typed \"PacifiCorp\" opens the Rocky Mountain Power program", "pp", "UT", "PacifiCorp", "rmp"],
    ["[B] UT typed \"Pacific Power\" opens the Rocky Mountain Power program", "pp", "UT", "Pacific Power", "rmp"],
    ["[C] UT typed \"Rocky Mountain Power\" opens the Rocky Mountain Power program", "pp", "UT", "Rocky Mountain Power", "rmp"],
    ["[D] ID typed \"RMP\" opens the Rocky Mountain Power program", "pp", "ID", "RMP", "rmp"],
    ["[E] OR typed \"PacifiCorp\" opens the Pacific Power program", "rmp", "OR", "PacifiCorp", "pp"],
    ["[F] OR typed \"Pacific Power\" opens the Pacific Power program", "rmp", "OR", "Pacific Power", "pp"],
  ];
  for (const [label, first, state, utility, want] of cases) {
    await check(label, async () => {
      const r = await openFrom(first, project(state, utility));
      assert(r.ok, `openSubmission failed: ${r.message}`);
      assert(r.program === want, `opened ${r.program}, want ${want}`);
    });
  }
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nPowerClerk program button smoke: all checks passed");
