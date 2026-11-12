// WAITING FOR A BOOTED SERVER ON THE REAL CONDITION (CI stability round, worker-flakes).
//
// lookupVerifyControl threw "server never came up" beside the DOM suite. Its server HAD come up: the
// suite's random band (6695-6709) holds 6697, one of the ports the Fetch standard forbids, so Node's
// fetch refused every /health poll with "bad port" for 90 s (1 run in 15, whatever the load; the
// banner in the failure's own log says "URL http://localhost:6697"). The fixed count of tries hid
// that, and it was wrong about two other states as well:
//   - the child EXITED (a crash, a refused port): the loop polled a dead process for the full 90 s
//     and then blamed the server for being slow;
//   - one `fetch` that never answered had no timeout of its own, so a single poll could stall.
// waitForServer waits for what is true: it fails AT ONCE when the child exits (exit code and the
// child's output) or when the URL can never be fetched (a fetch-blocked port); every poll has its own
// timeout; and it prints how long the boot took. FETCH_BLOCKED_PORTS is the standard's list, and
// serverBootWait.test.ts fails if any suite's port band contains one.
import type { ChildProcess } from "node:child_process";

export const SERVER_BOOT_BUDGET_MS = 90_000;
/** The Fetch standard's "bad ports" (https://fetch.spec.whatwg.org/#port-blocking): fetch() refuses
 *  them outright, so a test server on one is unreachable by the suite that booted it. */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115,
  117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 5_000;

/** Collects a child's stdout/stderr (the tail is what a failure prints). Attach right after spawn. */
export function captureOutput(child: ChildProcess): () => string {
  let log = "";
  child.stdout?.on("data", (d) => { log += String(d); });
  child.stderr?.on("data", (d) => { log += String(d); });
  return () => log;
}

export async function waitForServer(child: ChildProcess, url: string, opts: { budgetMs?: number; output?: () => string } = {}): Promise<{ bootMs: number }> {
  const budget = opts.budgetMs ?? SERVER_BOOT_BUDGET_MS;
  const t0 = Date.now();
  const tail = (): string => (opts.output?.() ?? "").slice(-2000);
  let exited: string | null = child.exitCode !== null || child.signalCode !== null ? `code ${child.exitCode} signal ${child.signalCode}` : null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => { exited = `code ${code} signal ${signal}`; };
  child.once("exit", onExit);
  let last = "no answer yet";
  try {
    while (Date.now() - t0 < budget) {
      if (exited) throw new Error(`the server process exited before it answered ${url} (${exited}) after ${Date.now() - t0} ms. output tail:\n${tail()}`);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
        if (res.ok) return { bootMs: Date.now() - t0 };
        last = `HTTP ${res.status}`;
      } catch (e) {
        last = String((e as { cause?: unknown })?.cause ?? (e as Error)?.message ?? e).slice(0, 120);
        // A refusal no wait can heal: fetch will never request this port.
        if (/bad port/i.test(last)) throw new Error(`fetch refuses ${url} outright (${last}): the port is on the Fetch standard's blocked list, so the server can never be reached from this suite — pick a port band without one (FETCH_BLOCKED_PORTS). output tail:\n${tail()}`);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(`the server process is still running but did not answer ${url} within ${budget} ms (last: ${last}). output tail:\n${tail()}`);
  } finally {
    child.off("exit", onExit);
  }
}
