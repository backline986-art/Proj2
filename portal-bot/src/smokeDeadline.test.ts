// smokeDeadline (#584): a case that misses its deadline is a NAMED red, at once; a case on time is
// untouched; a smoke's declared whole-run budget is read from its header and can only raise the
// runner's default.
//   npx tsx portal-bot/src/smokeDeadline.test.ts
import assert from "node:assert/strict";
import { DEADLINE_EXIT_CODE, declaredSmokeTimeoutSeconds, effectiveSmokeTimeoutMs, smokeWatchdog, withDeadline } from "./smokeDeadline";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

await check("a case on time: its value passes through and nothing exits", async () => {
  const exits: number[] = [];
  const v = await withDeadline("C1", 500, new Promise<string>((r) => setTimeout(() => r("done"), 10)), (c) => { exits.push(c); });
  assert.equal(v, "done");
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(exits, [], "the cleared deadline never fires later");
});

await check("a case on time that REJECTS: the rejection passes through (the smoke's own red)", async () => {
  const exits: number[] = [];
  await assert.rejects(withDeadline("C2", 500, Promise.reject(new Error("boom")), (c) => { exits.push(c); }), /boom/);
  assert.deepEqual(exits, []);
});

await check("a case that never settles: a FAIL line naming it, and an exit with the red code, at the deadline", async () => {
  const exits: number[] = [];
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const t0 = Date.now();
  try {
    await assert.rejects(withDeadline("C10 a slow server", 150, new Promise<never>(() => {}), (c) => { exits.push(c); }), /deadline/);
  } finally { console.error = orig; }
  const ms = Date.now() - t0;
  assert.deepEqual(exits, [DEADLINE_EXIT_CODE]);
  assert.ok(lines.some((l) => /^\s*FAIL - C10 a slow server: did not finish within 0s/.test(l)), JSON.stringify(lines));
  assert.ok(ms >= 140 && ms < 2000, `fired at ${ms}ms`);
});

await check("the runner's FAIL_LINE shape matches the deadline's line", () => {
  assert.match("  FAIL - C10: did not finish within 120s — a hang, named by the smoke (#584)", /^\s*FAIL\s+-\s/);
});

await check("declared budget: a // header line is read", () => {
  assert.equal(declaredSmokeTimeoutSeconds("// A smoke.\n// dom-smoke-timeout: 1200\nimport x from 'y';\n"), 1200);
  assert.equal(declaredSmokeTimeoutSeconds("//dom-smoke-timeout: 900s\n"), 900);
});

await check("declared budget: absent, zero, prose, a string literal, or past the first 4 KB is no declaration", () => {
  assert.equal(declaredSmokeTimeoutSeconds("// nothing here\n"), null);
  assert.equal(declaredSmokeTimeoutSeconds("// dom-smoke-timeout: 0\n"), null);
  assert.equal(declaredSmokeTimeoutSeconds("// set a dom-smoke-timeout: 900 in the header\n"), null);
  assert.equal(declaredSmokeTimeoutSeconds(`const s = "dom-smoke-timeout: 900";\n`), null);
  assert.equal(declaredSmokeTimeoutSeconds(`${"// pad\n".repeat(700)}// dom-smoke-timeout: 900\n`), null);
});

await check("effective budget: a declaration only ever RAISES the runner's default", () => {
  assert.equal(effectiveSmokeTimeoutMs(600_000, "// dom-smoke-timeout: 1200\n"), 1_200_000);
  assert.equal(effectiveSmokeTimeoutMs(600_000, "// dom-smoke-timeout: 60\n"), 600_000);
  assert.equal(effectiveSmokeTimeoutMs(600_000, "// none\n"), 600_000);
  assert.equal(effectiveSmokeTimeoutMs(1_800_000, "// dom-smoke-timeout: 1200\n"), 1_800_000, "a larger --timeout still wins");
});

await check("the whole-run watchdog names the LAST case started when the run overstays", async () => {
  const exits: number[] = [];
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const w = smokeWatchdog("someSmoke", 100, (c) => { exits.push(c); });
    w.at("C8"); w.at("C10");
    await new Promise((r) => setTimeout(r, 250));
  } finally { console.error = orig; }
  assert.deepEqual(exits, [DEADLINE_EXIT_CODE]);
  assert.ok(lines.some((l) => /^\s*FAIL - someSmoke: the whole run did not finish .* last case it started was C10/.test(l)), JSON.stringify(lines));
});

await check("a stopped watchdog never fires", async () => {
  const exits: number[] = [];
  const w = smokeWatchdog("someSmoke", 80, (c) => { exits.push(c); });
  w.stop();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(exits, []);
});

if (failures) { console.error(`\nsmokeDeadline.test: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nsmokeDeadline.test: PASS");
