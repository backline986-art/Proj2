// ONE READ, ONE ANSWER (#263). A single gate read used to build the same reviewer report five times,
// and the history report, the application package and the process map four times each: the submit
// gate builds them, then asks the process map and the installer packet, which build them again.
// On the production board that was 0.75 s of blocked server per job, per read.
//
// This is a memo for ONE synchronous read, not a cache. An answer is reused only when all of these hold:
//   - the same `withReadMemo` call is still on the stack (it is cleared in `finally`, so it never
//     outlives the read, and never crosses an `await`: a promise returned by `fn` resumes after it);
//   - the same database handle, and NOT ONE write through it since the answer was built
//     (`AppDb.writeSeq`). An answer whose own build wrote something is never stored;
//   - the same key, the same `SKIP_CODE_RESEARCH` setting, and (where the caller passes one) the
//     same input, compared in full as text.
// Every reader gets its own copy (structuredClone), so one reader changing its copy cannot reach
// another. Outside `withReadMemo` nothing is remembered and every call computes as before.
import type { AppDb } from "./db";

interface Entry { seq: number; input: string; value: unknown }
interface Scope { db: AppDb; entries: Map<string, Entry> }

let active: Scope | null = null;
let enabled = true;
const reused = new Map<string, number>();

/** Run one synchronous read with the memo on. Nested calls share the outer one. */
export function withReadMemo<T>(db: AppDb, fn: () => T): T {
  if (active || !enabled) return fn();
  active = { db, entries: new Map() };
  try {
    return fn();
  } finally {
    active = null;
  }
}

/** `compute()`, or the copy of the answer this same read already built for `key` and `input`. */
export function memoRead<T>(db: AppDb, key: string, inputOf: () => string, compute: () => T): T {
  const scope = active;
  if (!scope || scope.db !== db) return compute();
  const input = inputOf();
  const fullKey = `${key}|${process.env.SKIP_CODE_RESEARCH || ""}`;
  const hit = scope.entries.get(fullKey);
  if (hit && hit.seq === db.writeSeq && hit.input === input) {
    const kind = key.split(":")[0];
    reused.set(kind, (reused.get(kind) || 0) + 1);
    return structuredClone(hit.value) as T;
  }
  const before = db.writeSeq;
  const value = compute();
  if (db.writeSeq === before) {
    let copy: unknown;
    try { copy = structuredClone(value); } catch { return value; }
    scope.entries.set(fullKey, { seq: before, input, value: copy });
  } else {
    scope.entries.delete(fullKey);
  }
  return value;
}

/** Test seam: is a read memo on the stack right now. */
export function readMemoActive(): boolean {
  return active !== null;
}

/** Test seam: how many times an answer of each kind ("gate", "hist", "appdocs", "pmap") was reused. */
export function readMemoReuseCounts(): Record<string, number> {
  return Object.fromEntries(reused);
}

/** Test seam: turn the memo off (every call computes) to compare answers, or back on. Clears the counts. */
export function setReadMemoForTest(on: boolean): void {
  enabled = on;
  reused.clear();
}
