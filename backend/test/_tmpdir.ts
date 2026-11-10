// A TEST'S TEMP DIR, REMOVED WITHOUT FAILING A GREEN RUN (#618).
//
// On Windows, fs.rmSync throws EBUSY/EPERM on a SQLite file that is still open — this process's own
// database handle, or a server child that has not finished exiting — AFTER every check in the suite
// already passed, and the uncaught throw turns the green run red. Retry briefly (a child that is
// exiting lets go within a second or two), then leave the directory for the OS temp sweep: a leftover
// temp folder is not a test result. Any other error is still thrown.
import fs from "node:fs";

export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM") {
      console.log(`  note - temp dir left for the OS to clean (${code}): ${dir}`);
      return;
    }
    throw err;
  }
}
