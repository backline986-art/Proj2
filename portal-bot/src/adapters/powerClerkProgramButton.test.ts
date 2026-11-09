// WHICH PACIFICORP PROGRAM BUTTON A JOB'S NAME MATCHES (#602) — the pure half of
// powerClerkProgramButton.dom.smoke.ts, so it runs in the unit suite (and CI) without a browser.
// A Utah / Idaho / Wyoming PacifiCorp job opens "New Rocky Mountain Power … Application" however the
// utility was typed; an Oregon / Washington / California one opens "New Pacific Power … Application".
// KILL: restore the stateless `/pacificorp|pacific power/i ? "Pacific Power"` mapping -> the UT rows fail.
//
//   npx tsx portal-bot/src/adapters/powerClerkProgramButton.test.ts
import { powerClerkProgramButtonName } from "./powerClerk";

const PP = "New Pacific Power Customer Generation Application";
const RMP = "New Rocky Mountain Power Customer Generation Application";
const PGE = "New Net Metering Application";

let failures = 0;
const row = (state: string, utility: string, want: string) => {
  const re = powerClerkProgramButtonName({ state, utility } as never);
  const others = [PP, RMP, PGE].filter((b) => b !== want);
  const okNow = re.test(want) && others.every((b) => !re.test(b));
  if (okNow) console.log(`ok   - ${state || "(no state)"} "${utility}" -> ${want}`);
  else { failures++; console.error(`FAIL - ${state || "(no state)"} "${utility}" -> want ${want}, got ${re}`); }
};

// Utah is the first market: every PacifiCorp spelling opens Rocky Mountain Power's program.
row("UT", "PacifiCorp", RMP);
row("UT", "Pacific Power", RMP);
row("Utah", "PACIFICORP", RMP);
row("UT", "Rocky Mountain Power", RMP);
row("UT", "RMP", RMP);
row("ID", "Pacific Power", RMP);
row("WY", "PacifiCorp", RMP);
// Pacific Power's states keep the Pacific Power program.
row("OR", "PacifiCorp", PP);
row("OR", "Pacific Power", PP);
row("WA", "Pacific Power", PP);
row("CA", "PacifiCorp", PP);
// No state: the pre-#602 answer — the brand it was typed as (never a guess of Rocky Mountain Power).
row("", "PacifiCorp", PP);
row("", "Pacific Power", PP);
row("", "Rocky Mountain Power", RMP);
// PGE is untouched: its button carries no utility name.
row("OR", "PGE", PGE);
row("OR", "Portland General Electric", PGE);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\npowerClerkProgramButton: all checks passed");
