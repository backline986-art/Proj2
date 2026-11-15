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
// Review of #245: ONLY WHAT THE CLICK DID COUNTS. The round-1 rule also called undone a wizard that
// moved on through a transient route (#/w?step=1 → #/loading → #/w?step=2) and a search whose router
// re-added its default page=1 — the click's effect held both times, and the replay retried Continue
// (skipping a page) or false-stopped "advance: Search". Those rows (T1-T4) fail on the round-1 rule.
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
  // Flipped in the review round: a parameter the old state lacked is a new state; the URL cannot tell
  // "went back and added its own" from a wizard #/w → #/loading → #/w?step=2 that moved on (below).
  { label: "back on the route it left, with a parameter it did not have there → not undone (a new state; today's reading)",
    before: `${H}#/a`, clicked: `${H}#/b`, settled: `${H}#/a?x=1`, undone: false },
  { label: "the click's URL held → not undone",
    before: `${H}#/a`, clicked: `${H}#/b?q=1`, settled: `${H}#/b?q=1`, undone: false },
  { label: "a click that did not change the URL → never undone",
    before: `${H}#/a`, clicked: `${H}#/a`, settled: `${H}#/b`, undone: false },
  { label: "a parameter the click changed was changed back → undone",
    before: `${H}#/s?q=1`, clicked: `${H}#/s?q=2`, settled: `${H}#/s?q=1`, undone: true },
  { label: "a parameter the click changed holds, another was added → not undone",
    before: `${H}#/s?q=1`, clicked: `${H}#/s?q=2`, settled: `${H}#/s?q=2&page=1`, undone: false },
  // Flipped in the review round: only what the click SET counts. A removed parameter put back reads
  // like a router re-adding its default; and this URL is `before` again, which the replay's urlMoved
  // already reads as not moved before it asks this question, so only the stop's wording changes.
  { label: "a parameter the click removed was put back → not undone (only what the click set counts)",
    before: `${H}#/s?q=1&f=x`, clicked: `${H}#/s?q=1`, settled: `${H}#/s?q=1&f=x`, undone: false },
  // ── review of #245: the shapes the round-1 rule called undone although the click's effect held ──
  { label: "T1 transient: #/w?step=1 → #/loading → #/w?step=2 (back on the route, moved on) → not undone",
    before: `${H}#/w?step=1`, clicked: `${H}#/loading`, settled: `${H}#/w?step=2`, undone: false },
  { label: "transient from a step with no parameter: #/w → #/loading → #/w?step=2 → not undone",
    before: `${H}#/w`, clicked: `${H}#/loading`, settled: `${H}#/w?step=2`, undone: false },
  { label: "transient back exactly where it was: #/w?step=1 → #/loading → #/w?step=1 → undone",
    before: `${H}#/w?step=1`, clicked: `${H}#/loading`, settled: `${H}#/w?step=1`, undone: true },
  { label: "back where it was with its parameters in another order → undone",
    before: `${H}#/list?a=1&b=2`, clicked: `${H}#/detail`, settled: `${H}#/list?b=2&a=1`, undone: true },
  { label: "T2 search: #/search → ?q=solar → ?q=solar&page=1 (the router adds its default page) → not undone",
    before: `${H}#/search`, clicked: `${H}#/search?q=solar`, settled: `${H}#/search?q=solar&page=1`, undone: false },
  { label: "search from a page=1 URL: #/search?page=1 → ?q=solar → ?q=solar&page=1 → not undone",
    before: `${H}#/search?page=1`, clicked: `${H}#/search?q=solar`, settled: `${H}#/search?q=solar&page=1`, undone: false },
  { label: "T3 search on page 2: ?q=a&page=2 → ?q=b → ?q=b&page=1 (the default re-added) → not undone",
    before: `${H}#/s?q=a&page=2`, clicked: `${H}#/s?q=b`, settled: `${H}#/s?q=b&page=1`, undone: false },
  { label: "T4 EnerGov menu Apply from inside the assistant: ?showTemplates=false → (none) → ?showTemplates=false → not undone",
    before: `${H}#/applicationAssistant?showTemplates=false`, clicked: `${H}#/applicationAssistant`, settled: `${H}#/applicationAssistant?showTemplates=false`, undone: false },
  { label: "Tigard Search with Apply already settled (?sectionName=Trending): the rewrite dropped sectionName=All → undone",
    before: `${H}#/applicationAssistant?sectionName=Trending&showTemplates=false`, clicked: `${H}#/applicationAssistant?sectionName=All&showTemplates=false`, settled: `${H}#/applicationAssistant?showTemplates=false`, undone: true },
  { label: "an empty parameter the router drops is normalising: ?x=1 → ?x=1&q= → ?x=1&page=1 → not undone",
    before: `${H}#/s?x=1`, clicked: `${H}#/s?x=1&q=`, settled: `${H}#/s?x=1&page=1`, undone: false },
  { label: "path router search normalised: /search → /search?q=x → /search?q=x&page=1 → not undone",
    before: "https://p.example.test/search", clicked: "https://p.example.test/search?q=x", settled: "https://p.example.test/search?q=x&page=1", undone: false },
  { label: "a parameter-only click, then the page went on to another route → not undone",
    before: `${H}#/s?q=1`, clicked: `${H}#/s?q=2`, settled: `${H}#/detail?id=9`, undone: false },
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
