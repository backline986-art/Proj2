// #231 — THE HOST THE RECIPE'S OWN PORTAL URL LANDED ON IS THE RECIPE'S PORTAL FOR THE RUN, AND
// NOTHING ELSE IS. Real Chromium, the adapter's real login() (openPortal, the portal goto, the
// sign-in with a synthetic credential) and fillApplication.
//
// Live (City of Meridian, Accela, replay sweep 2026-11-14): recipe.portalUrl is the vanity host
// https://citizenportal.meridiancity.org/CitizenAccess/, which redirects to
// https://aca-prod.accela.com/meridian/Default.aspx. Replay opened portalUrl, landed and SIGNED IN on
// aca-prod.accela.com, then refused the recipe's step 0 { goto
// https://aca-prod.accela.com/MERIDIAN/Dashboard.aspx, note "entry url" }: "goto leaves the recipe's
// portal (meridiancity.org) for accela.com — stopped rather than followed".
//
// REPLICA (no live portal): one local server answering by Host header; Chromium resolves every
// *.localhost name to loopback, so each name below is its own host (and site) to the gate.
//   citizenportal.meridiancity.localhost/CitizenAccess/  302 -> aca-prod.accela.localhost/meridian/Default.aspx
//   aca-prod.accela.localhost/meridian/…                 the landed portal (signed in: a "Log out" link)
//   signin.meridiancity.localhost/CitizenAccess/         302 -> aca-prod.accela.localhost/signin/Default.aspx,
//                                                        a REAL sign-in form whose POST 302s to ->
//   myaccount.cityservices.localhost                     a host only the sign-in's own redirect reaches
//   elsewhere.localhost                                  a third site no goto may reach
//   permits.cityof.localhost/apply/                      a PERMIT portalUrl that 302s to ->
//   pgenm.powerclerk.localhost                           a utility (PowerClerk) portal, a REAL sign-in form
//   power.cityelectric.localhost/                        a UTILITY portalUrl that 302s to ->
//   permits.cityx.localhost/CitizenAccess/               a city's self-hosted Accela (a permit portal)
// The fixture's redirects are instant server-side 302s. A redirect a script fires after the page has
// settled is NOT covered: the landing is read once, so such a run stops at its first goto there.
//
// MUST-PASS: the Meridian shape replays past step 0 (the goto to the landed host) and fills the
//   dashboard's box; the landing is named on the login's "portal goto" phase, never as an aging note.
// MUST-PASS / MUST-EXCLUDE (the landing is read BEFORE the sign-in): with a real sign-in on the
//   landed host whose POST redirects to another host, the landed host is adopted, step 0 runs, and
//   the host the sign-in redirected to is NOT adopted — the recipe's later goto there is refused.
// MUST-EXCLUDE: after the landing, a goto to a third site is refused, named, and never requested.
// MUST-EXCLUDE: a permit recipe whose portalUrl lands on a PowerClerk host stops at login, named,
//   and NO credential is posted to that host; the host is not adopted; driven on anyway, the
//   recipe's goto there is still refused by the track rule.
// MUST-EXCLUDE (rule 5's own predicate, portalChannel.trackSafeUrl): a utility recipe whose portalUrl
//   lands on a city's self-hosted Accela (/CitizenAccess) stops at login, named, and the permit host
//   sees nothing beyond the landing (recipeAdapter.test.ts drives the Apply re-entry that follows).
// MUST-KEEP: no redirect — the run, the gate and its words are exactly main's.
//
// Run: npx tsx portal-bot/src/adapters/landedPortalSite.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import type { Page } from "playwright";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Synthetic credential: never a real login.
const CREDENTIAL = { username: "smoke-user-231", password: "smoke-pass-231" };
const hits: string[] = [];
// Every POST: host + path, and whether it carried a password field. Never the body itself.
const posts: Array<{ at: string; credential: boolean }> = [];
let port = 0;
const at = (host: string, path: string): string => `http://${host}:${port}${path}`;
const page = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><div id="nav"><a href="/Logout.aspx">Log out</a></div>${body}</body></html>`;
// A sign-in page: no sign-out control, a username + password form posting to `action`.
const signIn = (title: string, action: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><h2>Sign In</h2><form method="post" action="${action}">`
  + `<label for="u">User Name</label> <input id="u" name="username" type="text" autocomplete="username"> `
  + `<label for="p">Password</label> <input id="p" name="password" type="password" autocomplete="current-password"> `
  + `<button type="submit" id="btnLogin">Sign In</button></form></body></html>`;
const server = http.createServer((req, res) => {
  const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  const url = new URL(req.url || "/", "http://x");
  hits.push(`${host}${url.pathname}`);
  const html = (body: string): void => { res.writeHead(200, { "content-type": "text/html" }); res.end(body); };
  const redirect = (to: string): void => { res.writeHead(302, { location: to }); res.end(); };
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      posts.push({ at: `${host}${url.pathname}`, credential: /(?:^|&)password=[^&]+/.test(body) });
      if (host === "aca-prod.accela.localhost" && /^\/signin\/Login\.aspx$/i.test(url.pathname)) { redirect(at("myaccount.cityservices.localhost", "/welcome")); return; }
      if (host === "pgenm.powerclerk.localhost" && /^\/MvcAccount\/Login$/i.test(url.pathname)) { redirect(at("pgenm.powerclerk.localhost", "/MvcProjects/Home")); return; }
      res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
    });
    return;
  }
  if (host === "citizenportal.meridiancity.localhost" && /^\/CitizenAccess\/?$/i.test(url.pathname)) { redirect(at("aca-prod.accela.localhost", "/meridian/Default.aspx")); return; }
  if (host === "signin.meridiancity.localhost" && /^\/CitizenAccess\/?$/i.test(url.pathname)) { redirect(at("aca-prod.accela.localhost", "/signin/Default.aspx")); return; }
  if (host === "aca-prod.accela.localhost" && /^\/meridian\/Default\.aspx$/i.test(url.pathname)) {
    html(page("Accela Citizen Access", `<h2>Welcome to the City of Meridian</h2>`)); return;
  }
  if (host === "aca-prod.accela.localhost" && /^\/(meridian|signin)\/Dashboard\.aspx$/i.test(url.pathname)) {
    html(page("Accela Citizen Access", `<h2>Dashboard</h2><label for="proj">Project Name:</label> <input id="proj" type="text">`)); return;
  }
  if (host === "aca-prod.accela.localhost" && /^\/signin\/Default\.aspx$/i.test(url.pathname)) { html(signIn("Accela Citizen Access", "/signin/Login.aspx")); return; }
  if (host === "myaccount.cityservices.localhost") { html(page("My Account", `<h2>Signed in</h2><label for="m">Project Name:</label> <input id="m" type="text">`)); return; }
  if (host === "elsewhere.localhost") { html(page("Elsewhere", `<label for="x">Project Name:</label> <input id="x" type="text">`)); return; }
  if (host === "permits.cityof.localhost" && /^\/apply\/?$/i.test(url.pathname)) { redirect(at("pgenm.powerclerk.localhost", "/MvcAccount/Login")); return; }
  if (host === "pgenm.powerclerk.localhost" && /^\/MvcAccount\/Login$/i.test(url.pathname)) { html(signIn("PowerClerk", "/MvcAccount/Login")); return; }
  if (host === "pgenm.powerclerk.localhost") { html(page("PowerClerk", `<h2>Interconnection projects</h2>`)); return; }
  if (host === "power.cityelectric.localhost" && url.pathname === "/") { redirect(at("permits.cityx.localhost", "/CitizenAccess/Default.aspx")); return; }
  if (host === "permits.cityx.localhost") { html(page("Accela Citizen Access", `<h2>City X permits</h2>`)); return; }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
port = (server.address() as { port: number }).port;

const VANITY = at("citizenportal.meridiancity.localhost", "/CitizenAccess/");
const LANDED = at("aca-prod.accela.localhost", "/meridian/Default.aspx");
const DASHBOARD = at("aca-prod.accela.localhost", "/MERIDIAN/Dashboard.aspx");
const SIGNIN_VANITY = at("signin.meridiancity.localhost", "/CitizenAccess/");
const SIGNIN_DASHBOARD = at("aca-prod.accela.localhost", "/signin/Dashboard.aspx");
const POSTLOGIN = at("myaccount.cityservices.localhost", "/profile");
const THIRD = at("elsewhere.localhost", "/apply");
const PERMIT_VANITY = at("permits.cityof.localhost", "/apply/");
const PC_HOME = at("pgenm.powerclerk.localhost", "/MvcProjects/Home");
const UTILITY_VANITY = at("power.cityelectric.localhost", "/");
const ACCELA_HOST = `aca-prod.accela.localhost:${port}`;

const recipeOf = (scopeType: "ahj" | "utility", portalUrl: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "landed-portal-site", scopeType, profileKey: "id|city of meridian|idaho power", state: "ID", ahj: "City of Meridian", utility: "",
  portalPlatform: "accela", portalUrl, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", discipline: "electrical", steps,
} as unknown as PortalRecipe);
const entry = (url: string): RecipeStep => ({ action: "goto", value: url, note: "entry url" });
const fillProject: RecipeStep = { action: "fill", selector: { label: "Project Name:" }, field: "projectName", note: "Project Name:" };
const stop = { action: "stopForReview" } as RecipeStep;

type Outcome = {
  login: { ok: boolean; message: string; data?: Record<string, unknown> }; fill: { ok: boolean; message: string; data?: Record<string, unknown> } | null;
  adopted: string; url: string; box: string; hits: string[]; posts: Array<{ at: string; credential: boolean }>; gotoNote: string; notes: string[]; refusals: string[];
};
async function run(recipe: PortalRecipe, opts: { driveOnAfterRefusedLogin?: boolean } = {}): Promise<Outcome> {
  hits.length = 0;
  posts.length = 0;
  const adapter = new RecipeAdapter(recipe, { projectName: "Smoke 231" }, {});
  try {
    const login = await adapter.login({ headless: true, credential: CREDENTIAL }) as Outcome["login"];
    const adopted = String((adapter as unknown as { landedPortalHost?: string }).landedPortalHost ?? "");
    let fill: Outcome["fill"] = null;
    if (login.ok || opts.driveOnAfterRefusedLogin) {
      try { fill = await adapter.fillApplication({} as ProjectRecord) as Outcome["fill"]; } catch (e) { fill = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
    }
    const pg = (adapter as unknown as { page: Page | null }).page;
    const url = pg ? pg.url() : "";
    const box = pg ? await pg.evaluate(() => (document.querySelector("input[type=text]") as HTMLInputElement | null)?.value ?? "(none)").catch(() => "(unreadable)") : "(no page)";
    const phases = ((login.data ?? {}) as { phaseTimings?: Array<{ phase: string; note?: string }> }).phaseTimings ?? [];
    const gotoNote = String(phases.find((p) => p.phase === "portal goto")?.note ?? "");
    const data = (fill?.data ?? {}) as { agingNotes?: string[] };
    return { login, fill, adopted, url, box, hits: [...hits], posts: [...posts], gotoNote, notes: data.agingNotes ?? [], refusals: [...adapter.guardRefusals] };
  } finally {
    await adapter.close().catch(() => null);
  }
}
const say = (o: Outcome): string => `login=${o.login.ok}:${o.login.message.slice(0, 220)} | fill=${o.fill ? `${o.fill.ok}:${o.fill.message.slice(0, 260)}` : "(not run)"} | adopted=${o.adopted || "(none)"} url=${o.url} box=${o.box} | gotoNote=${JSON.stringify(o.gotoNote)} | hits=${JSON.stringify(o.hits)} | posts=${JSON.stringify(o.posts)} | agingNotes=${JSON.stringify(o.notes.filter((n) => /landed/.test(n)))} | refusals=${JSON.stringify(o.refusals)}`;
const reNote = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

try {
  // MUST-PASS — the Meridian shape (already signed in on the landed host).
  const a = await run(recipeOf("ahj", VANITY, [entry(DASHBOARD), fillProject, stop]));
  check("PRECONDITION (Meridian): the run opens portalUrl, lands on the Accela host and is signed in there (true on main too)",
    a.login.ok && /aca-prod\.accela\.localhost/.test(a.url), say(a));
  check("MUST-PASS (Meridian): step 0's goto to the landed host runs and the dashboard's box is filled",
    !!a.fill?.ok && a.box === "Smoke 231" && a.hits.includes("aca-prod.accela.localhost/MERIDIAN/Dashboard.aspx"), say(a));
  check("MUST-PASS (Meridian): the landing is named on the login's portal-goto phase, and is not an aging (re-record) note",
    reNote(`landed on ${ACCELA_HOST}`).test(a.gotoNote) && !a.notes.some((n) => /landed on/.test(n)), say(a));

  // MUST-PASS / MUST-EXCLUDE — the landing is read BEFORE the sign-in: a real sign-in on the landed
  // host whose POST redirects to another host.
  const s = await run(recipeOf("ahj", SIGNIN_VANITY, [entry(SIGNIN_DASHBOARD), fillProject, entry(POSTLOGIN), stop]));
  check("PRECONDITION (real sign-in): the synthetic credential is posted on the landed host and the sign-in lands on the other host",
    s.login.ok && s.posts.some((p) => p.at === "aca-prod.accela.localhost/signin/Login.aspx" && p.credential) && s.hits.includes("myaccount.cityservices.localhost/welcome"), say(s));
  check("MUST-PASS (real sign-in): the landed host is adopted, not the host the sign-in redirected to", s.adopted === ACCELA_HOST, say(s));
  check("MUST-PASS (real sign-in): step 0's goto to the landed host runs and the dashboard's box is filled",
    s.hits.includes("aca-prod.accela.localhost/signin/Dashboard.aspx") && s.box === "Smoke 231", say(s));
  check("MUST-EXCLUDE (real sign-in): the recipe's goto to the host the sign-in redirected to is refused, named, and never requested",
    !!s.fill && !s.fill.ok && reNote(`goto leaves the recipe's portal (meridiancity.localhost, landed on ${ACCELA_HOST}) for myaccount.cityservices.localhost:${port}`).test(s.fill.message)
      && !s.hits.includes("myaccount.cityservices.localhost/profile"), say(s));

  // MUST-EXCLUDE — a third site after that landing.
  const b = await run(recipeOf("ahj", VANITY, [entry(DASHBOARD), fillProject, entry(THIRD), stop]));
  check("MUST-EXCLUDE (third site): the goto is refused, named",
    !!b.fill && !b.fill.ok && reNote(`replay safety gate refused: goto leaves the recipe's portal (meridiancity.localhost, landed on ${ACCELA_HOST}) for elsewhere.localhost:${port}`).test(b.fill.message), say(b));
  check("MUST-EXCLUDE (third site): the third site is never requested", !b.hits.some((h) => h.startsWith("elsewhere.localhost")), say(b));

  // MUST-EXCLUDE — a permit portalUrl that lands on a PowerClerk host showing a real sign-in form.
  const c = await run(recipeOf("ahj", PERMIT_VANITY, [entry(PC_HOME), stop]), { driveOnAfterRefusedLogin: true });
  check("MUST-EXCLUDE (permit -> PowerClerk): login stops, named",
    !c.login.ok && reNote(`replay safety gate refused: the recipe's portal (cityof.localhost) landed on pgenm.powerclerk.localhost:${port} — a permit recipe may not open a utility (PowerClerk) portal`).test(c.login.message), say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): no credential is posted to the PowerClerk host (the stop comes before the sign-in)",
    !c.posts.some((p) => p.at.startsWith("pgenm.powerclerk.localhost")), say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): the utility host is not adopted", c.adopted === "", say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): recorded as a refusal", c.refusals.some((r) => /^REFUSED goto \(open the recipe's portal\): .*powerclerk\.localhost/.test(r)), say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): driven on anyway, the recipe's goto there is refused by the track rule",
    !!c.fill && !c.fill.ok && /replay safety gate refused: a permit recipe may not open a utility \(PowerClerk\) portal: powerclerk\.localhost/.test(c.fill.message), say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): the PowerClerk host saw only the redirect's landing",
    c.hits.filter((h) => h.startsWith("pgenm.powerclerk.localhost")).join(",") === "pgenm.powerclerk.localhost/MvcAccount/Login", say(c));

  // MUST-EXCLUDE — a utility portalUrl that lands on a city's self-hosted Accela (rule 5's own
  // predicate; the gate's regex names no such host). Not driven on here: its missing "navigate to
  // application" click waits out ~300 s of locator timeouts in real Chromium before the Apply
  // re-entry (a URL built from page.url()) is tried — recipeAdapter.test.ts drives that loop.
  const u = await run(recipeOf("utility", UTILITY_VANITY, [
    { action: "click", selector: { role: "link", name: "Apply" }, note: "navigate to application: Apply" } as RecipeStep, stop,
  ]));
  check("MUST-EXCLUDE (utility -> self-hosted Accela): login stops, named",
    !u.login.ok && reNote(`landed on permits.cityx.localhost:${port} — a utility recipe may not open a permit portal: permits.cityx.localhost:${port}`).test(u.login.message), say(u));
  check("MUST-EXCLUDE (utility -> self-hosted Accela): the permit host is not adopted", u.adopted === "", say(u));
  check("MUST-EXCLUDE (utility -> self-hosted Accela): the permit host saw only the redirect's landing (no sign-in, no Apply flow)",
    u.hits.filter((h) => h.startsWith("permits.cityx.localhost")).join(",") === "permits.cityx.localhost/CitizenAccess/Default.aspx" && !u.posts.length, say(u));

  // MUST-KEEP — no redirect: main's run and main's words.
  const d = await run(recipeOf("ahj", LANDED, [entry(DASHBOARD), fillProject, stop]));
  check("MUST-KEEP (no redirect): the run passes as on main, nothing adopted, no landing note",
    d.login.ok && !!d.fill?.ok && d.box === "Smoke 231" && d.adopted === "" && !/landed on/.test(d.gotoNote) && !d.notes.some((n) => /landed on/.test(n)), say(d));
  const e = await run(recipeOf("ahj", LANDED, [entry(DASHBOARD), fillProject, entry(THIRD), stop]));
  check("MUST-KEEP (no redirect): a third site is refused in main's exact words",
    !!e.fill && !e.fill.ok && e.fill.message.includes("goto leaves the recipe's portal (accela.localhost) for elsewhere.localhost — stopped rather than followed")
      && !e.hits.some((h) => h.startsWith("elsewhere.localhost")), say(e));
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} landed-portal-host check(s) FAILED.`); process.exit(1); }
console.log("\nAll landed-portal-host checks passed (real Chromium, replica redirects, a real sign-in form).");
process.exit(0);
