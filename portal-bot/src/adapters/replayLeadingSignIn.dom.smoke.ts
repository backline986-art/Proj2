// #280 — A RECIPE'S RECORDED SIGN-IN IS NOT REPLAYED INTO A SESSION THAT IS ALREADY SIGNED IN.
//
// Every hand recording starts with the person signing in, so the recipe's first steps are the
// sign-in: a click that opens it, a user-name fill, the SENSITIVE credential fill the recorder
// writes without a value, the click that sends it. On replay the engine signs in by itself first
// (the login phase: performLogin), so the page is the signed-in home and the recorded first click
// names a control that no longer exists. The replay waited and failed: "no control on this page
// matches …".
//
// Real Chromium, the adapter's real login() (openPortal, the portal goto, performLogin with a
// synthetic credential) and fillApplication. One local server, two synthetic sites by Host header
// (Chromium resolves every *.localhost name to loopback), built differently:
//   permits.alpha.localhost  a multi-page site: the home shows a "Sign In / Register" LINK when
//                            signed out and a "My Account" menu with a sign-out link when signed in;
//                            the sign-in is its own page with a classic form.
//   apply.beta.localhost     a one-page front: the home shows a "Log in" BUTTON that reveals
//                            an inline form when signed out, and an account bar whose sign-off is a
//                            script-driven control (no href, no id) when signed in.
//
// (a) MUST-PASS  the session is signed in when the steps begin (already signed in on alpha; signed
//                in by the engine's own login phase on beta and on alpha) -> the leading sign-in
//                sequence is skipped as a unit and named once, the application steps run, review
//                is reached.
// (b) MUST-KEEP  no signed-in signal (the login phase did not run) -> the recorded steps run as
//                today: the sign-in link is clicked, the sign-in form sent, and today's failure
//                stands where a step cannot be found.
// (c) MUST-EXCLUDE  a recipe whose first sensitive fill comes after application fills, and one whose
//                first sensitive fill is bound to a project field, have no leading sign-in
//                sequence: nothing is skipped.
// (d) MUST-EXCLUDE  a recipe with no sensitive fill is untouched.
// (e) the final submit is never clicked in any case (0 filing POSTs).
//
// Run: npx tsx portal-bot/src/adapters/replayLeadingSignIn.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const CREDENTIAL = { username: "synthetic-filer-280", password: "synthetic-pass-280" };
const RECORDED_USER = "recorded-login-name"; // the literal a hand recording stored for the user name
const ALPHA = "permits.alpha.localhost";
const BETA = "apply.beta.localhost";

// ── the server ────────────────────────────────────────────────────────────────────────────────
type Hit = { host: string; method: string; path: string; user?: string; hasPassword?: boolean };
const hits: Hit[] = [];
let filings = 0;
/** Every visitor to this host is treated as signed in (a session the browser already holds). */
const preSigned = new Set<string>();

const page = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const applyForm = (action: string): string => `<h1>New application</h1>
  <form method="post" action="${action}">
    <p><label for="title">Project title</label> <input id="title" name="title" type="text"></p>
    <p><label for="code">Access code</label> <input id="code" name="code" type="password" autocomplete="off"></p>
    <p><label for="acct">Service account</label> <input id="acct" name="acct" type="text"></p>
    <button type="submit">Continue</button>
  </form>`;
const reviewPage = (title: string): string => `<h1>Review your application</h1>
  <p>Project title: <span id="shown-title">${title.replace(/[<>&"]/g, "")}</span></p>
  <form method="post" action="/file"><button type="submit" id="file-it">Submit application</button></form>`;

const server = http.createServer((req, res) => {
  const host = String(req.headers.host || "").split(":")[0];
  const url = new URL(req.url || "/", `http://${host}`);
  const cookie = String(req.headers.cookie || "");
  const signedIn = preSigned.has(host) || /(?:^|;\s*)sess=1/.test(cookie);
  const send = (status: number, html: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "text/html", ...headers });
    res.end(html);
  };
  const withBody = (then: (form: URLSearchParams) => void): void => {
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => then(new URLSearchParams(raw)));
  };
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (req.method === "POST" && url.pathname === "/file") {
    filings++;
    hits.push({ host, method: "POST", path: "/file" });
    send(200, page("Filed", "<h1>Application filed</h1>"));
    return;
  }
  if (req.method === "POST" && (url.pathname === "/enter" || url.pathname === "/session")) {
    withBody((form) => {
      const user = String(form.get("who") ?? form.get("member") ?? "");
      const pass = String(form.get("secret") ?? form.get("pin") ?? "");
      hits.push({ host, method: "POST", path: url.pathname, user, hasPassword: pass.length > 0 });
      const good = (user === CREDENTIAL.username && pass === CREDENTIAL.password);
      if (good) send(302, "", { location: "/", "set-cookie": "sess=1; Path=/" });
      else send(200, page("Sign in", "<h1>Sign in</h1><p>That did not match our records.</p>"));
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/apply") {
    withBody((form) => {
      hits.push({ host, method: "POST", path: "/apply" });
      send(200, page("Review", reviewPage(String(form.get("title") ?? ""))));
    });
    return;
  }
  hits.push({ host, method: String(req.method), path: url.pathname });
  if (url.pathname === "/apply") {
    if (!signedIn) { send(302, "", { location: "/" }); return; }
    send(200, page("Apply", applyForm("/apply")));
    return;
  }
  if (host === ALPHA) {
    if (url.pathname === "/enter") {
      send(200, page("Sign in", `<h1>Sign in to your account</h1>
        <form method="post" action="/enter">
          <p><label for="who">User Name</label> <input id="who" name="who" type="text"></p>
          <p><label for="secret">Password</label> <input id="secret" name="secret" type="password"></p>
          <button type="submit">Sign-In</button>
        </form>`));
      return;
    }
    send(200, page("Permit centre", signedIn
      ? `<nav><details open><summary>My Account</summary><a href="/signout">Sign out</a></details></nav>
         <h1>Permit centre</h1><p><a href="/apply">Start an application</a></p>`
      : `<nav><a href="/enter">Sign In / Register</a></nav><h1>Permit centre</h1><p>Sign in to start an application.</p>`));
    return;
  }
  // BETA: one page; the form is revealed in place, the sign-off is a scripted control.
  send(200, page("Online services", signedIn
    ? `<header><div class="acct"><span>Signed in as a member</span>
         <span role="button" tabindex="0" onclick="location.href='/bye'">Log off account</span></div></header>
       <main><h2>Online services</h2><div><a href="/apply">Begin a new request</a></div></main>`
    : `<header><button type="button" onclick="document.getElementById('gate').hidden=false">Log in</button></header>
       <main><h2>Online services</h2>
       <section id="gate" hidden><form method="post" action="/session">
         <div><label>Member ID <input name="member" type="text"></label></div>
         <div><label>Passphrase <input name="pin" type="password"></label></div>
         <input type="submit" value="Enter">
       </form></section></main>`));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const at = (host: string, path = "/"): string => `http://${host}:${port}${path}`;

// ── the recipes ───────────────────────────────────────────────────────────────────────────────
const SENSITIVE_NOTE = "SENSITIVE — bind to credential/redacted field (no value stored).";
const recipeOf = (host: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "leading-sign-in", scopeType: "ahj", profileKey: "zz|sample|", state: "ZZ", ahj: "Sample", utility: "",
  portalPlatform: "fixture", portalUrl: at(host), status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", steps,
} as unknown as PortalRecipe);
/** The recorder's shape for a hand recording's sign-in on each site. */
const signInAlpha: RecipeStep[] = [
  { action: "click", selector: { role: "link", name: "Sign In / Register" }, note: "Sign In / Register" },
  { action: "fill", selector: { role: "textbox", name: "User Name" }, fingerprint: { id: "who", name: "who" }, value: RECORDED_USER, note: "User Name" },
  { action: "fill", selector: { role: "textbox", name: "Password" }, fingerprint: { id: "secret", name: "secret" }, sensitive: true, optional: true, note: `${SENSITIVE_NOTE} Password` },
  { action: "click", selector: { role: "button", name: "Sign-In" }, note: "Sign-In" },
] as RecipeStep[];
const signInBeta: RecipeStep[] = [
  { action: "click", selector: { role: "button", name: "Log in" }, note: "Log in" },
  { action: "fill", selector: { role: "textbox", name: "Member ID" }, fingerprint: { name: "member" }, value: RECORDED_USER, note: "Member ID" },
  { action: "fill", selector: { role: "textbox", name: "Passphrase" }, fingerprint: { name: "pin" }, sensitive: true, optional: true, note: `${SENSITIVE_NOTE} Passphrase` },
  { action: "click", selector: { role: "button", name: "Enter" }, note: "Enter" },
] as RecipeStep[];
const startAlpha = { action: "click", selector: { role: "link", name: "Start an application" }, note: "Start an application" } as RecipeStep;
const startBeta = { action: "click", selector: { role: "link", name: "Begin a new request" }, note: "Begin a new request" } as RecipeStep;
const fillTitle = { action: "fill", selector: { label: "Project title" }, fingerprint: { id: "title", name: "title" }, field: "projectName", note: "Project title" } as RecipeStep;
const next = { action: "click", selector: { role: "button", name: "Continue" }, note: "Continue" } as RecipeStep;
const tail: RecipeStep[] = [
  { action: "stopForReview" } as RecipeStep,
  { action: "click", selector: { role: "button", name: "Submit application" }, isFinalSubmit: true, note: "Submit application" } as RecipeStep,
];
const application = (start: RecipeStep): RecipeStep[] => [start, fillTitle, next, ...tail];

// ── the runs ──────────────────────────────────────────────────────────────────────────────────
type StepResult = { ok: boolean; message: string; data?: Record<string, unknown> };
type Outcome = { login: StepResult | null; fill: StepResult | null; url: string; heading: string; shownTitle: string; hits: Hit[]; notes: string[]; warnings: string[]; trace: Array<{ i: number; outcome: string }> };
const FIELDS = { projectName: "Synthetic Project 280", accountNumber: "SYNTH-ACCT" };
const readEnd = async (pg: Page | null): Promise<{ url: string; heading: string; shownTitle: string }> => {
  if (!pg) return { url: "", heading: "", shownTitle: "" };
  const read = await pg.evaluate(() => ({
    heading: (document.querySelector("h1, h2")?.textContent || "").trim(),
    shownTitle: (document.querySelector("#shown-title")?.textContent || "").trim(),
  })).catch(() => ({ heading: "(unreadable)", shownTitle: "" }));
  return { url: pg.url(), ...read };
};
const outcomeOf = async (adapter: RecipeAdapter, login: StepResult | null, fill: StepResult | null, pg: Page | null): Promise<Outcome> => {
  const inner = adapter as unknown as { agingNotes: string[]; driftWarnings: string[] };
  const data = (fill?.data ?? {}) as { trace?: Array<{ i: number; outcome: string }> };
  return { login, fill, ...(await readEnd(pg)), hits: [...hits], notes: [...inner.agingNotes], warnings: [...inner.driftWarnings], trace: data.trace ?? [] };
};
/** The real path: login() (the engine's own sign-in phase) and then the recipe. */
async function run(recipe: PortalRecipe): Promise<Outcome> {
  hits.length = 0;
  const adapter = new RecipeAdapter(recipe, FIELDS, {});
  const inner = adapter as unknown as { page: Page | null };
  try {
    const login = await adapter.login({ headless: true, credential: CREDENTIAL }) as StepResult;
    let fill: StepResult | null = null;
    if (login.ok) {
      try { fill = await adapter.fillApplication({} as ProjectRecord) as StepResult; } catch (e) { fill = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
    }
    return await outcomeOf(adapter, login, fill, inner.page);
  } finally {
    await adapter.close().catch(() => null);
  }
}
const say = (o: Outcome): string => `login=${o.login ? `${o.login.ok}:${o.login.message.slice(0, 160)}` : "(not run)"} | fill=${o.fill ? `${o.fill.ok}:${o.fill.message.slice(0, 400)}` : "(not run)"} | url=${o.url} heading=${JSON.stringify(o.heading)} title=${JSON.stringify(o.shownTitle)} | notes=${JSON.stringify(o.notes)} | warnings=${JSON.stringify(o.warnings).slice(0, 300)} | hits=${JSON.stringify(o.hits.map((h) => `${h.method} ${h.host.split(".")[1]}${h.path}`))}`;
const skipNotes = (o: Outcome): string[] => o.notes.filter((n) => /sign-in/i.test(n) && /not replayed/i.test(n));
const atReview = (o: Outcome): boolean => !!o.fill?.ok && /Review your application/.test(o.heading) && o.shownTitle === FIELDS.projectName;
const signInPosts = (o: Outcome): Hit[] => o.hits.filter((h) => h.method === "POST" && (h.path === "/enter" || h.path === "/session"));

try {
  // (a1) ALREADY SIGNED IN (the browser holds a session), multi-page site.
  preSigned.add(ALPHA);
  const a1 = await run(recipeOf(ALPHA, [...signInAlpha, ...application(startAlpha)]));
  check("PRECONDITION (a1): the login phase reads the session as already signed in", !!a1.login?.ok && /already signed in|existing session/i.test(a1.login.message), say(a1));
  check("(a1) MUST-PASS: already signed in — the application steps run and review is reached", atReview(a1), say(a1));
  check("(a1) MUST-PASS: the leading sign-in sequence is named ONCE, with its step numbers and why",
    skipNotes(a1).length === 1 && /steps? 1.{1,3}4\b/.test(skipNotes(a1)[0]) && /signed in/i.test(skipNotes(a1)[0]), say(a1));
  check("(a1) the note carries no recorded value (the stored user name is one client's login)", !a1.notes.concat(a1.warnings).some((n) => n.includes(RECORDED_USER)) && !String(a1.fill?.message ?? "").includes(RECORDED_USER), say(a1));
  check("(a1) no sign-in was sent and the sign-in page was never opened", signInPosts(a1).length === 0 && !a1.hits.some((h) => h.path === "/enter"), say(a1));
  preSigned.delete(ALPHA);

  // (a2) SIGNED IN BY THE ENGINE'S OWN LOGIN PHASE, one-page site, with a leading goto in the recipe.
  const a2 = await run(recipeOf(BETA, [{ action: "goto", value: at(BETA), note: "entry url" } as RecipeStep, ...signInBeta, ...application(startBeta)]));
  check("PRECONDITION (a2): the login phase signs in with the stored login (one credential POST, with a password)",
    !!a2.login?.ok && /logged in/i.test(a2.login.message) && signInPosts(a2).length === 1 && signInPosts(a2)[0].user === CREDENTIAL.username && signInPosts(a2)[0].hasPassword === true, say(a2));
  check("(a2) MUST-PASS: signed in by the engine — the leading goto runs, the recorded sign-in is skipped, review is reached", atReview(a2), say(a2));
  check("(a2) MUST-PASS: the sequence is named once (steps 2-5: the goto before it is not part of it)",
    skipNotes(a2).length === 1 && /steps? 2.{1,3}5\b/.test(skipNotes(a2)[0]), say(a2));

  // (a3) SIGNED IN BY THE ENGINE on the multi-page site (the incident's shape, end to end).
  const a3 = await run(recipeOf(ALPHA, [...signInAlpha, ...application(startAlpha)]));
  check("PRECONDITION (a3): the login phase signs in with the stored login", !!a3.login?.ok && /logged in/i.test(a3.login.message) && signInPosts(a3).length === 1 && signInPosts(a3)[0].user === CREDENTIAL.username, say(a3));
  check("(a3) MUST-PASS: the recorded sign-in is skipped and named once; review is reached", atReview(a3) && skipNotes(a3).length === 1, say(a3));

  // (b) MUST-KEEP: NO SIGNED-IN SIGNAL — the recorded steps run as today. The login phase is not run
  // (the page is handed to the replay as it is, signed out), so nothing says the session is signed in.
  {
    hits.length = 0;
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
      const pg = await ctx.newPage();
      const adapter = new RecipeAdapter(recipeOf(ALPHA, [{ action: "goto", value: at(ALPHA), note: "entry url" } as RecipeStep, ...signInAlpha, ...application(startAlpha)]), FIELDS, {});
      (adapter as unknown as { page: unknown }).page = pg;
      const fill = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: `threw ${String(e).slice(0, 300)}` })) as StepResult;
      const b = await outcomeOf(adapter, null, fill, pg);
      check("(b) MUST-KEEP: not signed in — nothing is skipped as a sign-in sequence", skipNotes(b).length === 0 && !b.trace.some((t) => /leading sign-in/.test(t.outcome)), say(b));
      // As today: the recorded sign-in link is clicked and the recorded sign-in button sends the
      // form. The password step stores no value, and the replay's shared-recipe rule leaves a
      // literal under a login-name label blank, so the sign-in the portal receives is empty and
      // the run then fails at the first application step — today's failure, unchanged.
      check("(b) MUST-KEEP: the recorded sign-in steps run (sign-in page opened, the recorded sign-in click sent the form, no password)",
        b.hits.some((h) => h.method === "GET" && h.path === "/enter") && signInPosts(b).length === 1 && signInPosts(b)[0].hasPassword === false && signInPosts(b)[0].user !== CREDENTIAL.username, say(b));
      check("(b) MUST-KEEP: today's failure stands — the run stops, named, at the step it could not find", !b.fill?.ok && /Recipe step failed \(click — Start an application\)/.test(String(b.fill?.message ?? "")), say(b));
    } finally {
      await browser.close().catch(() => null);
    }
  }

  // (c) MUST-EXCLUDE: the first sensitive fill comes AFTER an application fill — not a sign-in.
  preSigned.add(ALPHA);
  const accessCode = { action: "fill", selector: { label: "Access code" }, fingerprint: { id: "code", name: "code" }, sensitive: true, optional: true, note: `${SENSITIVE_NOTE} Access code` } as RecipeStep;
  const c1 = await run(recipeOf(ALPHA, [startAlpha, fillTitle, accessCode, next, ...tail]));
  check("(c1) MUST-EXCLUDE: a sensitive fill after an application fill is not a sign-in sequence — nothing skipped, review reached",
    skipNotes(c1).length === 0 && atReview(c1) && c1.hits.some((h) => h.method === "GET" && h.path === "/apply"), say(c1));
  // …and a first sensitive fill BOUND TO A PROJECT FIELD (an account number) is not a credential.
  const boundSecret = { action: "fill", selector: { label: "Service account" }, fingerprint: { id: "acct", name: "acct" }, field: "accountNumber", sensitive: true, optional: true, note: 'SENSITIVE — bound to project field "accountNumber" (no value stored). Service account' } as RecipeStep;
  const c2 = await run(recipeOf(ALPHA, [startAlpha, boundSecret, next, { action: "stopForReview" } as RecipeStep, tail[1]]));
  check("(c2) MUST-EXCLUDE: clicks then a project-bound sensitive fill is not a sign-in sequence — the first click still runs",
    skipNotes(c2).length === 0 && c2.hits.some((h) => h.method === "GET" && h.path === "/apply") && c2.hits.some((h) => h.method === "POST" && h.path === "/apply"), say(c2));

  // (d) MUST-EXCLUDE: no sensitive fill at all — untouched.
  const d = await run(recipeOf(ALPHA, application(startAlpha)));
  check("(d) MUST-EXCLUDE: a recipe with no sensitive fill is untouched — nothing skipped, review reached", skipNotes(d).length === 0 && atReview(d), say(d));
  preSigned.delete(ALPHA);

  // (e) THE FINAL SUBMIT IS NEVER CLICKED.
  check("(e) the final submit was never clicked in any case (0 filing POSTs)", filings === 0, `filing POSTs=${filings}`);
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} replay-leading-sign-in check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-leading-sign-in checks passed (real Chromium).");
process.exit(0);
