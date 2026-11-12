// THE LEARNER NEVER RESUMES SOMEBODY ELSE'S DRAFT ON A PLANNER'S SAY-SO (#351).
//
// After the permit-type tile a portal can show a no-field notice that names an application already
// in progress — "You have an application in progress. Draft 2026-0141, 77 Other Ave." — with one
// Continue into that draft. On main the planner's "advance Continue" opened the draft, typed this
// project's address over the draft's own and posted its save (the Helm's d3). Walked by the REAL
// learner against synthetic pages on 127.0.0.1 (the held-shape harness, twice per shape: with no
// verified information page and with a near-miss one):
//   d3    the planner advances the notice's GET Continue      -> stopped, the draft never opened
//   d3n   the Continue is a link the planner navigates        -> stopped
//   d3r   the control reads "Resume Application"              -> stopped
//   d3s   the planner says nothing (the interstitial pass)    -> stopped
//   d3x   "Create New" is offered, the planner picks Continue, and again when told -> stopped
//   d3c   "Create New" is offered, the planner picks Continue, is told, takes Create New -> its own form
//   d3new "Start a New Application" is offered                -> its own form, walked on
// Every stop names the draft. Only the continue-draft path (#302) resumes a draft, and only the
// one that matches this project.
//
//   npx tsx portal-bot/src/adapters/foreignDraftNotice.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { runHeldShapes } from "./infoPageHeldHarness";

await runHeldShapes("foreignDraftNotice.dom.smoke", ["d3", "d3n", "d3r", "d3s", "d3x", "d3c", "d3new"], { concurrency: 3 });
