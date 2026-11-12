// A HANG IS A NAMED FAILURE, INSIDE THE SMOKE'S OWN BUDGET (#584).
//
// scripts/run-dom-smokes.ts kills a smoke at its wall-clock budget and reports TIMEOUT: "a hang,
// not a red check". That tells you THAT something never resolved, never WHICH case — on #584 two
// smokes were reported that way for days ("stops after C8", "stops after pcEnphaseInc"), and
// both turned out to be a long sum of waits, not one stuck case. Two pieces fix the report:
//
//   withDeadline — a smoke wraps each case in it. A case that has not settled by its deadline
//                  prints `FAIL - <case>: did not finish within Ns` (the line the runner already
//                  counts as a red check) and exits 1 at once: the stuck work holds a browser and
//                  will not finish, so waiting for the runner to kill it adds nothing.
//   `// dom-smoke-timeout: <seconds>` — a smoke whose cases are slow BY DESIGN (settle waits
//                  that pin a slow portal's timing) declares its own whole-run budget in its
//                  header, and the runner uses it instead of the default. It can only RAISE the
//                  budget: a declaration below the runner's default is ignored, so no smoke can
//                  make the runner stricter by accident. The declaration is read by
//                  declaredSmokeTimeoutSeconds, here, so the parse is unit-tested.

/** The exit code of a smoke whose case missed its deadline: an ordinary red. */
export const DEADLINE_EXIT_CODE = 1;

/**
 * Race `work` against `ms`. On time, its value (or its rejection) passes through untouched. Late:
 * print a named `FAIL - ` line and exit the process (`exit` is injectable for the unit test).
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  work: Promise<T>,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const secs = Math.round(ms / 1000);
      console.error(`  FAIL - ${label}: did not finish within ${secs}s — a hang, named by the smoke (#584)`);
      exit(DEADLINE_EXIT_CODE);
      reject(new Error(`${label}: deadline ${secs}s passed`));
    }, ms);
    // Not unref'd: a case whose stuck work holds nothing else alive must still be named.
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DECLARATION = /^\s*\/\/\s*dom-smoke-timeout:\s*(\d+)\s*(?:s\b|$)/m;

/**
 * The whole-run budget, in seconds, a smoke declares in its header (`// dom-smoke-timeout: 1200`),
 * or null. Only the first 4 KB is read, and only a `//` line comment counts: a budget is a header
 * fact, never something a fixture string or a later comment can set.
 */
export function declaredSmokeTimeoutSeconds(source: string): number | null {
  const m = DECLARATION.exec(source.slice(0, 4096));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The budget the runner applies: the declared one when it is LARGER than the default. */
export function effectiveSmokeTimeoutMs(defaultMs: number, source: string): number {
  const declared = declaredSmokeTimeoutSeconds(source);
  return declared !== null ? Math.max(defaultMs, declared * 1000) : defaultMs;
}

/**
 * The whole-run backstop for a long smoke: if the run has not finished `ms` after this call, print
 * a `FAIL - ` line naming the LAST case it started, and exit red. Call it with a margin under the
 * smoke's declared budget, so the smoke names its own hang before the runner has to kill it. The
 * timer is unref'd: a smoke that finished exits normally. `at(label)` records each case as it
 * starts; `stop()` disarms it.
 */
export function smokeWatchdog(
  smoke: string,
  ms: number,
  exit: (code: number) => void = (code) => process.exit(code),
): { at: (label: string) => void; stop: () => void } {
  let last = "(none yet: it stalled before the first case)";
  const timer = setTimeout(() => {
    console.error(`  FAIL - ${smoke}: the whole run did not finish within ${Math.round(ms / 1000)}s; the last case it started was ${last} (#584)`);
    exit(DEADLINE_EXIT_CODE);
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return { at: (label: string) => { last = label; }, stop: () => clearTimeout(timer) };
}
