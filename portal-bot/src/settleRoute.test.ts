// A ROUTE THE PAGE TOOK BACK IS NOT AN ADVANCE, AND A CLICK THAT CHANGED NOTHING WAITS ON NOTHING (#245).
//
// Live Tigard (Tyler EnerGov, an AngularJS single-page app), 2026-11-15, from the Playwright API log:
//   11:01:11.018 click "Apply"  → #/applicationAssistant
//   11:01:11.858 click "Search" → #/applicationAssistant?sectionName=All&showTemplates=false
//   11:01:12.142 the assistant's own initialisation ends → #/applicationAssistant?showTemplates=false
// The settled URL after Search still differs from the URL before it, yet the search is gone; the
// settled URL after Apply also differs from the one the click left (the app added a parameter), and
// that advance is real. routeEffectUndone must tell those two apart on the URLs alone, and must not
// call a redirect to another route ("#/loading" → "#/dashboard") undone.
//
// settleAfterRoute on a click that did not change the URL returns null with no page read beyond
// page.url(): no evaluate, no wait (the issue's MUST-KEEP).
//
// Browser-free. Run: npx tsx portal-bot/src/settleRoute.test.ts
import { routeEffectUndone, settleAfterRoute } from "./settle";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const H = "https://selfservice.example.test/apps/SelfService";
const cases: Array<{ label: string; before: string; clicked: string; settled: string; undone: boolean }> = [
  { label: "Tigard Search: the rewrite dropped sectionName=All the click set → undone",
    before: `${H}#/applicationAssistant`, clicked: `${H}#/applicationAssistant?sectionName=All&showTemplates=false`, settled: `${H}#/applicationAssistant?showTemplates=false`, undone: true },
  { label: "Tigard Apply: the app added ?showTemplates=false to the route the click opened → not undone",
    before: `${H}#/home`, clicked: `${H}#/applicationAssistant`, settled: `${H}#/applicationAssistant?showTemplates=false`, undone: false },
  { label: "a redirect on to another route (#/loading → #/dashboard) → not undone",
    before: `${H}#/home`, clicked: `${H}#/loading`, settled: `${H}#/dashboard`, undone: false },
  { label: "the page went back to the route it was on → undone",
    before: `${H}#/a`, clicked: `${H}#/b`, settled: `${H}#/a`, undone: true },
  { label: "went back to the route it was on, with a parameter of its own → undone",
    before: `${H}#/a`, clicked: `${H}#/b`, settled: `${H}#/a?x=1`, undone: true },
  { label: "the click's URL held → not undone",
    before: `${H}#/a`, clicked: `${H}#/b?q=1`, settled: `${H}#/b?q=1`, undone: false },
  { label: "a click that did not change the URL → never undone",
    before: `${H}#/a`, clicked: `${H}#/a`, settled: `${H}#/b`, undone: false },
  { label: "a parameter the click changed was changed back → undone",
    before: `${H}#/s?q=1`, clicked: `${H}#/s?q=2`, settled: `${H}#/s?q=1`, undone: true },
  { label: "a parameter the click changed holds, another was added → not undone",
    before: `${H}#/s?q=1`, clicked: `${H}#/s?q=2`, settled: `${H}#/s?q=2&page=1`, undone: false },
  { label: "a parameter the click removed was put back → undone",
    before: `${H}#/s?q=1&f=x`, clicked: `${H}#/s?q=1`, settled: `${H}#/s?q=1&f=x`, undone: true },
  { label: "path router: /apply → /apply/search?t=all → /apply (query dropped) → undone",
    before: "https://p.example.test/apply", clicked: "https://p.example.test/apply/search?t=all", settled: "https://p.example.test/apply", undone: true },
  { label: "path router: a full page load to a new path that then adds a query → not undone",
    before: "https://p.example.test/p1", clicked: "https://p.example.test/p2", settled: "https://p.example.test/p2?step=1", undone: false },
  { label: "a query parameter and a hash parameter of the same name are different parameters (the hash k=2 is gone → undone)",
    before: `${H}#/v`, clicked: `${H}#/v?k=2`, settled: `${H}?k=2#/v`, undone: true },
  { label: "an unparseable URL is never undone (the caller keeps today's reading)",
    before: "not a url", clicked: "also not", settled: "nor this", undone: false },
];
for (const c of cases) {
  const got = routeEffectUndone(c.before, c.clicked, c.settled);
  check(c.label, got === c.undone, `routeEffectUndone(${c.before}, ${c.clicked}, ${c.settled}) = ${got}`);
}

// A click that did not change the URL: one page.url() read, no evaluate, no wait.
{
  let evaluates = 0;
  const page = {
    url: () => `${H}#/applicationAssistant`,
    evaluate: async () => { evaluates++; return null; },
    addInitScript: async () => undefined,
  };
  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await settleAfterRoute(page as any, `${H}#/applicationAssistant`);
  const ms = Date.now() - t0;
  check("no URL change: settleAfterRoute returns null", r === null, JSON.stringify(r));
  check("no URL change: nothing is evaluated on the page", evaluates === 0, `evaluates=${evaluates}`);
  check("no URL change: nothing is waited on (< 20 ms)", ms < 20, `${ms} ms`);
}

// A page object that cannot be read (the unit-test doubles) is never waited on either.
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await settleAfterRoute({ url: () => `${H}#/b` } as any, `${H}#/a`);
  check("a page with no evaluate/addInitScript: null, nothing waited on", r === null, JSON.stringify(r));
}

// A URL that changed on a page whose probe reads as quiet: settled after the quiet window, bounded.
{
  let evaluates = 0;
  let t = 0;
  const page = {
    url: () => `${H}#/b`,
    // waitForSettled's snapshot: a quiet page (nothing busy), the page clock advancing with real time.
    evaluate: async () => {
      evaluates++;
      t = Date.now();
      return { doc: "d1", now: t, busy: [], lastActivity: 0, saw: { prm: 0, postback: 0, net: 0, mutation: 0, url: 0 }, hooked: { prm: false, doPostBack: false }, pageStart: t };
    },
    addInitScript: async () => undefined,
  };
  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await settleAfterRoute(page as any, `${H}#/a`);
  const ms = Date.now() - t0;
  check("URL changed: the settle ran and reports the clicked and settled URLs",
    !!r && r.clickedUrl === `${H}#/b` && r.settledUrl === `${H}#/b` && r.result.settled === true, JSON.stringify(r));
  check("URL changed on a quiet page: paid the quiet window (~300 ms), far under the bound", ms >= 250 && ms < 1500 && evaluates > 1, `${ms} ms, ${evaluates} evaluates`);
}

console.log(failures === 0 ? "settleRoute.test: PASS" : `settleRoute.test: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
