// A LOGIN READ OF AN ELEMENT THAT JUST LEFT THE PAGE IS BOUNDED (CI stability round, worker-flakes).
//
// The login poll asks "is a password box still here?" (loginFormPresent → firstVisible →
// isFillable). isFillable used locator.evaluate with no timeout, and Playwright's locator.evaluate
// re-resolves its selector and WAITS for a missing element — up to the 30 s default. When the
// submit's redirect landed between "a password box is visible" and that read, the read waited on
// the signed-in page for a box that never comes back: the poll's whole 15 s window passed inside
// one call and a GOOD login came back still_on_login ("the stored username/password was likely
// rejected"). Traced in idpChallenge.dom.smoke under load: the page sat on the signed-in home for
// 30 s while `locator('input[type="password"]').first().evaluate` waited, then the poll gave up.
//
// Pinned (browser-free: a page double whose locator behaves like Playwright's when its element
// has gone — evaluate waits for `options.timeout`, else the 30 s default, then throws):
//   1 BOUNDED      — loginFormPresent answers within a few seconds, not Playwright's 30 s default.
//   2 NOT A BOX    — and the answer is false: an element that is gone is nothing to type into.
//   3 STILL READS  — the same double with the element present answers true at once (the bound
//                    does not turn a real password box into "no login form").
//
// KILL (verified by hand): drop `{ timeout: ELEMENT_READ_TIMEOUT_MS }` from isFillable -> 1 FAILS.
//
// Run: npx tsx portal-bot/src/adapters/loginReadBounded.test.ts
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { loginFormPresent } from "./loginFlow";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 30_000;
/** A page with one visible `input[type="password"]` that `gone` says has (or has not) left by the
 *  time it is evaluated. Every other selector matches nothing. */
function pageDouble(gone: boolean): { page: Page; evaluateTimeouts: Array<number | undefined> } {
  const evaluateTimeouts: Array<number | undefined> = [];
  const passwordBox = {
    isVisible: async () => true,
    evaluate: (fn: (el: unknown) => unknown, _arg?: unknown, options?: { timeout?: number }) => {
      evaluateTimeouts.push(options?.timeout);
      if (!gone) return Promise.resolve(fn({ tagName: "INPUT", disabled: false, readOnly: false, name: "password", id: "pw", getAttribute: (a: string) => (a === "type" ? "password" : null) }));
      const wait = options?.timeout ?? PLAYWRIGHT_DEFAULT_TIMEOUT_MS;
      return new Promise((_, reject) => { setTimeout(() => reject(new Error(`locator.evaluate: Timeout ${wait}ms exceeded.`)), wait); });
    },
  };
  const none = { count: async () => 0, nth: () => none, first: () => none, isVisible: async () => false };
  const scope = {
    locator: (css: string) => (css === 'input[type="password"]' ? { count: async () => 1, nth: () => passwordBox, first: () => passwordBox } : none),
    getByLabel: () => none, getByRole: () => none, getByPlaceholder: () => none, getByTestId: () => none, getByText: () => none,
    // findInputByAdjacentLabel's in-page scan: no "Password:" label beside an input here.
    evaluate: async () => null,
  };
  const page = { ...scope, frames: () => [scope], url: () => "https://signed-in.example.test/home" } as unknown as Page;
  return { page, evaluateTimeouts };
}

await check("1+2. BOUNDED / NOT A BOX: a password box that left the page between 'visible' and the read answers false within seconds", async () => {
  const { page, evaluateTimeouts } = pageDouble(true);
  const t0 = Date.now();
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"stalled">((r) => { guardTimer = setTimeout(() => r("stalled"), 8000); });
  const answer = await Promise.race([loginFormPresent(page), guard]);
  clearTimeout(guardTimer);
  const ms = Date.now() - t0;
  assert.notEqual(answer, "stalled", `loginFormPresent was still waiting after ${ms} ms (evaluate timeouts asked: ${JSON.stringify(evaluateTimeouts)}) — the read is unbounded`);
  assert.equal(answer, false, "an element that is gone read as a password box");
  assert.ok(evaluateTimeouts.length > 0 && evaluateTimeouts.every((t) => typeof t === "number" && t <= 5000), `every element read must carry a bound: ${JSON.stringify(evaluateTimeouts)}`);
});

await check("3. STILL READS: the same password box, still on the page, is a login form at once", async () => {
  const { page } = pageDouble(false);
  const t0 = Date.now();
  assert.equal(await loginFormPresent(page), true);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

if (failures) { console.error(`\n${failures} loginReadBounded check(s) FAILED.`); process.exit(1); }
console.log("\nloginReadBounded: all checks passed");
process.exit(0);
