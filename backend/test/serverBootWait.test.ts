// SERVER-BOOTING SUITES WAIT ON THE SERVER'S REAL STATE (CI stability round, worker-flakes).
//
// lookupVerifyControl threw "server never came up" after 90 one-second polls of /health. The server
// was up: its random band 6695-6709 holds 6697, a port the Fetch standard blocks, and fetch refused
// every poll with "bad port" (1 run in 15). The same count would also have polled an EXITED server for
// 90 s. _serverBoot.waitForServer is the wait those suites use now.
//
// Pinned (with tiny node children, no backend):
//   1 EXITED    — a child that exits at once fails within a few seconds, naming its exit code and
//                 quoting its output (the old loop: 90 s, then "never came up").
//   2 SLOW      — a child that starts listening only after 4 s is waited for and answers.
//   3 NOT 200   — a child that answers 503 until it is ready is not called up early.
//   4 HUNG      — a child that accepts but never answers does not stall the wait past its budget:
//                 each poll has its own timeout, and the error says the process is still running.
//   5 BAD PORT  — a server on a fetch-blocked port fails at once, saying why.
//   6 BANDS     — no backend suite's port band (`N + Math.floor(Math.random() * M)` or
//                 `freePortInBand(N, M)`) contains a fetch-blocked port. Red on staging 1472b867
//                 (lookupVerifyControl's 6695-6709).
//
// KILLS (verified by hand): drop the exit check in waitForServer -> 1 FAILS (it waits the budget);
// put lookupVerifyControl's band back at 6695 -> 6 FAILS.
//
//   npx tsx backend/test/serverBootWait.test.ts
import "./_isolate";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";
import { FETCH_BLOCKED_PORTS, captureOutput, waitForServer } from "./_serverBoot";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail.slice(0, 600)}` : ""}`); }
  else console.log(`ok   - ${name}`);
};
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const child = (code: string): ChildProcess => spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] });
const kill = (c: ChildProcess): void => { try { c.kill("SIGKILL"); } catch { /* gone */ } };

{
  const c = child(`console.error("EADDRINUSE: synthetic refusal"); process.exit(3);`);
  const output = captureOutput(c);
  const t0 = Date.now();
  let err = "";
  try { await waitForServer(c, `http://127.0.0.1:${await freePort()}/health`, { budgetMs: 60_000, output }); } catch (e) { err = String((e as Error).message); }
  const ms = Date.now() - t0;
  check("1. EXITED: a child that exits fails within seconds, not after the budget", err !== "" && ms < 10_000, `${ms} ms: ${err}`);
  check("1. EXITED: the error names the exit code and quotes the child's output", /exited/.test(err) && /code 3/.test(err) && /EADDRINUSE: synthetic refusal/.test(err), err);
}

{
  const port = await freePort();
  const c = child(`setTimeout(() => require("http").createServer((q, r) => { r.end("ok"); }).listen(${port}, "127.0.0.1"), 4000);`);
  let res: { bootMs: number } | null = null; let err = "";
  try { res = await waitForServer(c, `http://127.0.0.1:${port}/health`, { budgetMs: 60_000 }); } catch (e) { err = String((e as Error).message); }
  check("2. SLOW: a server that listens after 4 s is waited for", !!res && res.bootMs >= 3500, err || JSON.stringify(res));
  kill(c);
}

{
  const port = await freePort();
  const c = child(`const t0 = Date.now(); require("http").createServer((q, r) => { r.statusCode = Date.now() - t0 < 2500 ? 503 : 200; r.end(); }).listen(${port}, "127.0.0.1");`);
  let res: { bootMs: number } | null = null; let err = "";
  try { res = await waitForServer(c, `http://127.0.0.1:${port}/health`, { budgetMs: 60_000 }); } catch (e) { err = String((e as Error).message); }
  check("3. NOT 200: a 503 is not taken as up; the wait ends once it answers 200", !!res && res.bootMs >= 2000, err || JSON.stringify(res));
  kill(c);
}

{
  const port = await freePort();
  const c = child(`require("net").createServer(() => { /* accept, never answer */ }).listen(${port}, "127.0.0.1");`);
  await new Promise((r) => setTimeout(r, 500));
  const t0 = Date.now();
  let err = "";
  try { await waitForServer(c, `http://127.0.0.1:${port}/health`, { budgetMs: 8_000 }); } catch (e) { err = String((e as Error).message); }
  const ms = Date.now() - t0;
  check("4. HUNG: a server that never answers fails at about its budget, saying it is still running", /still running/.test(err) && ms < 8_000 + 6_000, `${ms} ms: ${err}`);
  kill(c);
}

{
  const port = 6697; // fetch-blocked; nothing needs to listen there for fetch to refuse it
  const c = child(`setInterval(() => {}, 1000);`);
  const t0 = Date.now();
  let err = "";
  try { await waitForServer(c, `http://127.0.0.1:${port}/health`, { budgetMs: 60_000 }); } catch (e) { err = String((e as Error).message); }
  const ms = Date.now() - t0;
  check("5. BAD PORT: a fetch-blocked port fails at once, naming the cause", ms < 5_000 && /blocked list/.test(err), `${ms} ms: ${err}`);
  kill(c);
}

{
  const dir = path.join(REPO, "backend", "test");
  const offenders: string[] = [];
  let bands = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const re = /(\d{2,5})\s*\+\s*Math\.floor\(\s*Math\.random\(\)\s*\*\s*(\d+)\s*\)|freePortInBand\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;
    for (const m of src.matchAll(re)) {
      const start = Number(m[1] ?? m[3]);
      const count = Number(m[2] ?? m[4]);
      if (start < 1024) continue; // not a port band (a random offset into something else)
      bands++;
      for (let p = start; p < start + count; p++) if (FETCH_BLOCKED_PORTS.has(p)) offenders.push(`${f}: band ${start}-${start + count - 1} holds ${p}`);
    }
  }
  check("6. BANDS: no backend suite's port band holds a fetch-blocked port", bands > 20 && offenders.length === 0, `${bands} bands read; ${offenders.join("; ")}`);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nserverBootWait: all checks passed");
process.exit(0);
