// #231 — THE PORTAL THE RECIPE'S OWN PORTAL URL LANDED ON IS THE RECIPE'S PORTAL FOR THE RUN, AND
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
//   grid.cityelectric.localhost/                         a UTILITY portalUrl that 302s to ->
//   permits.cityy.localhost/                             a city host's ROOT (rule 5 passes it), whose
//                                                        /CitizenAccess/ pages are a permit portal
//   portal.cityutility.localhost/                        a UTILITY portalUrl that 302s to ->
//   identity.tylerhost-sso.localhost/signin              a permit-vendor identity host (the gate's own
//                                                        track rule refuses it), a REAL sign-in form
//                                                        whose POST 302s back to portal.cityutility
//   permits.cityof.localhost/apply/                      a PERMIT portalUrl that 302s to ->
//   pgenm.powerclerk.localhost                           a utility (PowerClerk) portal, a REAL sign-in form
//   power.cityelectric.localhost/                        a UTILITY portalUrl that 302s to ->
//   permits.cityx.localhost/CitizenAccess/               a city's self-hosted Accela (a permit portal)
// The fixture's redirects are instant server-side 302s. A redirect a script fires after the page has
// settled is NOT covered: the landing is read once, so such a run stops at its first goto there.
// No *.localhost name is a shared vendor host (portalChannel.isPathTenantedHost), so the path-tenant
// half of the rule (aca-prod.accela.com/MERIDIAN vs /CHINO) is recipeAdapter.test.ts's, on real
// host names with a fake page: a real one would send a request to the live vendor.
//
// MUST-PASS: the Meridian shape replays past step 0 (the goto to the landed portal) and fills the
//   dashboard's box; the landing is named on the login's "portal goto" phase, never as an aging note.
// MUST-PASS / MUST-EXCLUDE (the landing is read BEFORE the sign-in): with a real sign-in on the
//   landed host whose POST redirects to another host, the landed portal is adopted, step 0 runs, and
//   the host the sign-in redirected to is NOT — the recipe's later goto there is refused. The ORDER
//   PROBE checks it by event order: the landing's GET, then the adapter's read, then the credential
//   POST.
// MUST-EXCLUDE: after the landing, a goto to a third site, or to the landed host under another scheme,
//   is refused, named, and never requested.
// MUST-EXCLUDE (review of #231, rule 5 on the target): a utility recipe that landed on a city host's
//   root may go to that host's own pages, but its goto into /CitizenAccess/ there is refused by rule
//   5's own predicate (portalChannel.trackSafeUrl) and never requested.
// MUST-KEEP (an unadoptable landing changes nothing): a utility recipe whose sign-in bounces through
//   a permit-vendor identity host, a permit recipe landing on PowerClerk, a utility recipe landing on
//   a self-hosted Accela — each signs in and runs exactly as before the fix: no stop at login, no
//   refusal line there, nothing adopted, and a later goto to that host refused at that step in the
//   gate's usual words.
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
// The ORDER PROBE's timeline: each request the server sees ("GET host/path", "POST host/path") and
// each time the adapter reads where the portal landed ("READ <url>"), in the order they happened.
const events: string[] = [];
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
const box = `<label for="proj">Project Name:</label> <input id="proj" type="text">`;
const server = http.createServer((req, res) => {
  const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  const url = new URL(req.url || "/", "http://x");
  hits.push(`${host}${url.pathname}`);
  events.push(`${req.method} ${host}${url.pathname}`);
  const html = (body: string): void => { res.writeHead(200, { "content-type": "text/html" }); res.end(body); };
  const redirect = (to: string): void => { res.writeHead(302, { location: to }); res.end(); };
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      posts.push({ at: `${host}${url.pathname}`, credential: /(?:^|&)password=[^&]+/.test(body) });
      if (host === "aca-prod.accela.localhost" && /^\/signin\/Login\.aspx$/i.test(url.pathname)) { redirect(at("myaccount.cityservices.localhost", "/welcome")); return; }
      if (host === "pgenm.powerclerk.localhost" && /^\/MvcAccount\/Login$/i.test(url.pathname)) { redirect(at("pgenm.powerclerk.localhost", "/MvcProjects/Home")); return; }
      if (host === "identity.tylerhost-sso.localhost" && url.pathname === "/signin") { redirect(at("portal.cityutility.localhost", "/home")); return; }
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
    html(page("Accela Citizen Access", `<h2>Dashboard</h2>${box}`)); return;
  }
  if (host === "aca-prod.accela.localhost" && /^\/signin\/Default\.aspx$/i.test(url.pathname)) { html(signIn("Accela Citizen Access", "/signin/Login.aspx")); return; }
  if (host === "myaccount.cityservices.localhost") { html(page("My Account", `<h2>Signed in</h2>${box}`)); return; }
  if (host === "elsewhere.localhost") { html(page("Elsewhere", box)); return; }
  if (host === "grid.cityelectric.localhost" && url.pathname === "/") { redirect(at("permits.cityy.localhost", "/")); return; }
  if (host === "permits.cityy.localhost" && url.pathname === "/") { html(page("City Y", `<h2>City Y online services</h2>`)); return; }
  if (host === "permits.cityy.localhost" && url.pathname === "/home") { html(page("City Y", `<h2>Account</h2>${box}`)); return; }
  if (host === "permits.cityy.localhost") { html(page("Accela Citizen Access", `<h2>City Y permits</h2>${box}`)); return; }
  if (host === "portal.cityutility.localhost" && url.pathname === "/") { redirect(at("identity.tylerhost-sso.localhost", "/signin")); return; }
  if (host === "identity.tylerhost-sso.localhost" && url.pathname === "/signin") { html(signIn("Sign in", "/signin")); return; }
  if (host === "portal.cityutility.localhost") { html(page("City Utility", `<h2>Interconnection</h2>${box}`)); return; }
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
const DASHBOARD_HTTPS = `https://aca-prod.accela.localhost:${port}/MERIDIAN/Dashboard.aspx`;
const SIGNIN_VANITY = at("signin.meridiancity.localhost", "/CitizenAccess/");
const SIGNIN_DASHBOARD = at("aca-prod.accela.localhost", "/signin/Dashboard.aspx");
const POSTLOGIN = at("myaccount.cityservices.localhost", "/profile");
const THIRD = at("elsewhere.localhost", "/apply");
const GRID_VANITY = at("grid.cityelectric.localhost", "/");
const CITYY_HOME = at("permits.cityy.localhost", "/home");
const CITYY_CITIZEN_ACCESS = at("permits.cityy.localhost", "/CitizenAccess/Cap/CapHome.aspx");
const IDP_VANITY = at("portal.cityutility.localhost", "/");
const UTILITY_APPLY = at("portal.cityutility.localhost", "/apply");
const PERMIT_VANITY = at("permits.cityof.localhost", "/apply/");
const PC_HOME = at("pgenm.powerclerk.localhost", "/MvcProjects/Home");
const UTILITY_VANITY = at("power.cityelectric.localhost", "/");
const CITYX_CAP_HOME = at("permits.cityx.localhost", "/CitizenAccess/Cap/CapHome.aspx");
const ACCELA_ORIGIN = `http://aca-prod.accela.localhost:${port}`;

const recipeOf = (scopeType: "ahj" | "utility", portalUrl: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "landed-portal-site", scopeType, profileKey: "id|city of meridian|idaho power", state: "ID", ahj: "City of Meridian", utility: "",
  portalPlatform: "accela", portalUrl, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", discipline: "electrical", steps,
} as unknown as PortalRecipe);
const entry = (url: string): RecipeStep => ({ action: "goto", value: url, note: "entry url" });
const fillProject: RecipeStep = { action: "fill", selector: { label: "Project Name:" }, field: "projectName", note: "Project Name:" };
const stop = { action: "stopForReview" } as RecipeStep;

type Outcome = {
  login: { ok: boolean; message: string; data?: Record<string, unknown> }; fill: { ok: boolean; message: string; data?: Record<string, unknown> } | null;
  adopted: string; url: string; box: string; hits: string[]; posts: Array<{ at: string; credential: boolean }>; events: string[]; gotoNote: string; notes: string[];
  refusalsAtLogin: string[]; refusals: string[];
};
async function run(recipe: PortalRecipe): Promise<Outcome> {
  hits.length = 0;
  posts.length = 0;
  events.length = 0;
  const adapter = new RecipeAdapter(recipe, { projectName: "Smoke 231" }, {});
  // The ORDER PROBE's "READ": the adapter's own read of where the portal landed, timestamped into the
  // same timeline as the server's requests. A cross-check of private machinery, asserted last.
  const inner = adapter as unknown as { adoptLandedPortal?: () => void; page: Page | null; landedPortal?: { origin: string; tenant: string } | null };
  const read = inner.adoptLandedPortal;
  if (typeof read === "function") {
    inner.adoptLandedPortal = function (this: unknown) { events.push(`READ ${inner.page ? inner.page.url() : ""}`); return read.call(this); };
  }
  try {
    const login = await adapter.login({ headless: true, credential: CREDENTIAL }) as Outcome["login"];
    const refusalsAtLogin = [...adapter.guardRefusals];
    const p = inner.landedPortal;
    const adopted = p ? (p.tenant ? `${p.origin}/${p.tenant}` : p.origin) : "";
    let fill: Outcome["fill"] = null;
    if (login.ok) {
      try { fill = await adapter.fillApplication({} as ProjectRecord) as Outcome["fill"]; } catch (e) { fill = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
    }
    const pg = inner.page;
    const url = pg ? pg.url() : "";
    const boxValue = pg ? await pg.evaluate(() => (document.querySelector("input[type=text]") as HTMLInputElement | null)?.value ?? "(none)").catch(() => "(unreadable)") : "(no page)";
    const phases = ((login.data ?? {}) as { phaseTimings?: Array<{ phase: string; note?: string }> }).phaseTimings ?? [];
    const gotoNote = String(phases.find((ph) => ph.phase === "portal goto")?.note ?? "");
    const data = (fill?.data ?? {}) as { agingNotes?: string[] };
    return { login, fill, adopted, url, box: boxValue, hits: [...hits], posts: [...posts], events: [...events], gotoNote, notes: data.agingNotes ?? [], refusalsAtLogin, refusals: [...adapter.guardRefusals] };
  } finally {
    await adapter.close().catch(() => null);
  }
}
const say = (o: Outcome): string => `login=${o.login.ok}:${o.login.message.slice(0, 220)} | fill=${o.fill ? `${o.fill.ok}:${o.fill.message.slice(0, 260)}` : "(not run)"} | adopted=${o.adopted || "(none)"} url=${o.url} box=${o.box} | gotoNote=${JSON.stringify(o.gotoNote)} | events=${JSON.stringify(o.events)} | posts=${JSON.stringify(o.posts)} | agingNotes=${JSON.stringify(o.notes.filter((n) => /landed/.test(n)))} | refusalsAtLogin=${JSON.stringify(o.refusalsAtLogin)} refusals=${JSON.stringify(o.refusals)}`;
const reNote = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

try {
  // MUST-PASS — the Meridian shape (already signed in on the landed host).
  const a = await run(recipeOf("ahj", VANITY, [entry(DASHBOARD), fillProject, stop]));
  check("MUST-PASS (Meridian): step 0's goto to the landed portal runs and the dashboard's box is filled",
    !!a.fill?.ok && a.box === "Smoke 231" && a.hits.includes("aca-prod.accela.localhost/MERIDIAN/Dashboard.aspx"), say(a));
  check("MUST-PASS (Meridian): the landing is named on the login's portal-goto phase, and is not an aging (re-record) note",
    reNote(`landed on ${ACCELA_ORIGIN}`).test(a.gotoNote) && !a.notes.some((n) => /landed on/.test(n)), say(a));
  check("PRECONDITION (Meridian, true on main too): the run opens portalUrl, lands on the Accela host and is signed in there",
    a.login.ok && /aca-prod\.accela\.localhost/.test(a.url), say(a));

  // MUST-PASS / MUST-EXCLUDE — the landing is read BEFORE the sign-in: a real sign-in on the landed
  // host whose POST redirects to another host (one that would pass every adoption test).
  const s = await run(recipeOf("ahj", SIGNIN_VANITY, [entry(SIGNIN_DASHBOARD), fillProject, entry(POSTLOGIN), stop]));
  check("MUST-PASS (real sign-in): step 0's goto to the landed portal runs and the dashboard's box is filled",
    s.hits.includes("aca-prod.accela.localhost/signin/Dashboard.aspx") && s.box === "Smoke 231", say(s));
  check("MUST-EXCLUDE (real sign-in): the recipe's goto to the host the sign-in redirected to is refused, named, and never requested",
    !!s.fill && !s.fill.ok && reNote(`goto leaves the recipe's portal (meridiancity.localhost, landed on ${ACCELA_ORIGIN}) for http://myaccount.cityservices.localhost:${port} — stopped rather than followed`).test(s.fill.message)
      && !s.hits.includes("myaccount.cityservices.localhost/profile"), say(s));
  check("PRECONDITION (real sign-in): the page was NOT signed in — the synthetic credential is posted on the landed host and the sign-in lands on the other host",
    s.login.ok && s.posts.some((p) => p.at === "aca-prod.accela.localhost/signin/Login.aspx" && p.credential) && s.hits.includes("myaccount.cityservices.localhost/welcome"), say(s));
  {
    const iGet = s.events.indexOf("GET aca-prod.accela.localhost/signin/Default.aspx");
    const iRead = s.events.findIndex((e) => e.startsWith("READ ") && e.includes(`aca-prod.accela.localhost:${port}/signin/Default.aspx`));
    const iPost = s.events.indexOf("POST aca-prod.accela.localhost/signin/Login.aspx");
    check("ORDER PROBE (real sign-in): the landing's GET, then the adapter's read of it, then the credential POST — in that order, read once",
      iGet >= 0 && iRead > iGet && iPost > iRead && s.events.filter((e) => e.startsWith("READ ")).length === 1, say(s));
  }
  check("cross-check (real sign-in): the landed portal is adopted, not the host the sign-in redirected to", s.adopted === ACCELA_ORIGIN, say(s));

  // MUST-EXCLUDE — a third site, and the landed host under another scheme, after that landing.
  const b = await run(recipeOf("ahj", VANITY, [entry(DASHBOARD), fillProject, entry(THIRD), stop]));
  check("MUST-EXCLUDE (third site): the goto is refused, named, and never requested",
    !!b.fill && !b.fill.ok && reNote(`replay safety gate refused: goto leaves the recipe's portal (meridiancity.localhost, landed on ${ACCELA_ORIGIN}) for http://elsewhere.localhost:${port}`).test(b.fill.message)
      && !b.hits.some((h) => h.startsWith("elsewhere.localhost")), say(b));
  const sc = await run(recipeOf("ahj", VANITY, [entry(DASHBOARD_HTTPS), fillProject, stop]));
  check("MUST-EXCLUDE (another scheme): https on the landed http host is not the landed portal — refused, named, never requested",
    !!sc.fill && !sc.fill.ok && reNote(`goto leaves the recipe's portal (meridiancity.localhost, landed on ${ACCELA_ORIGIN}) for https://aca-prod.accela.localhost:${port} — stopped rather than followed`).test(sc.fill.message)
      && !sc.hits.includes("aca-prod.accela.localhost/MERIDIAN/Dashboard.aspx"), say(sc));

  // MUST-EXCLUDE — review of #231: rule 5 is asked of the TARGET, not only the landing. A utility
  // recipe lands on a city host's root (rule 5 passes it), goes to that host's own page, then tries
  // its /CitizenAccess/ (a self-hosted permit portal by its path).
  const m = await run(recipeOf("utility", GRID_VANITY, [entry(CITYY_HOME), fillProject, entry(CITYY_CITIZEN_ACCESS), stop]));
  check("MUST-PASS (utility, landed on a host root): its own page on the landed host runs and the box is filled",
    m.hits.includes("permits.cityy.localhost/home") && m.box === "Smoke 231", say(m));
  check("MUST-EXCLUDE (utility, landed on a host root): the goto into /CitizenAccess/ is refused by rule 5's words and never requested",
    !!m.fill && !m.fill.ok && reNote(`replay safety gate refused: a utility recipe may not open a permit portal: permits.cityy.localhost`).test(m.fill.message)
      && !m.hits.some((h) => /^permits\.cityy\.localhost\/CitizenAccess/i.test(h)), say(m));
  check("cross-check (utility, landed on a host root): the root was adopted — the refusal came from the target check", m.adopted === `http://permits.cityy.localhost:${port}`, say(m));

  // MUST-KEEP — an unadoptable landing changes nothing. The identity bounce: a utility recipe whose
  // portalUrl lands on a permit-vendor identity host (a real sign-in form there), which redirects
  // back to the utility's portal.
  const idp = await run(recipeOf("utility", IDP_VANITY, [entry(UTILITY_APPLY), fillProject, stop]));
  check("MUST-KEEP (identity bounce): no stop at login — the sign-in runs, comes back, and the run fills the box as before",
    idp.login.ok && !!idp.fill?.ok && idp.box === "Smoke 231" && idp.hits.includes("portal.cityutility.localhost/apply"), say(idp));
  check("MUST-KEEP (identity bounce): no refusal line at login, nothing refused at all", idp.refusalsAtLogin.length === 0 && idp.refusals.length === 0, say(idp));
  check("PRECONDITION (identity bounce): the credential was posted on the identity host (the sign-in actually ran)",
    idp.posts.some((p) => p.at === "identity.tylerhost-sso.localhost/signin" && p.credential), say(idp));
  check("cross-check (identity bounce): the identity host is not adopted", idp.adopted === "" && !/landed on/.test(idp.gotoNote), say(idp));

  // MUST-KEEP — a permit portalUrl that lands on a PowerClerk host: as before the fix, the sign-in
  // runs there, and the recipe's goto there is refused by the track rule at that step.
  const c = await run(recipeOf("ahj", PERMIT_VANITY, [entry(PC_HOME), stop]));
  check("MUST-KEEP (permit -> PowerClerk): no stop at login and no refusal line there (as before the fix)",
    c.login.ok && c.refusalsAtLogin.length === 0, say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): the recipe's goto there is refused by the track rule, at that step",
    !!c.fill && !c.fill.ok && /replay safety gate refused: a permit recipe may not open a utility \(PowerClerk\) portal: powerclerk\.localhost/.test(c.fill.message), say(c));
  check("cross-check (permit -> PowerClerk): the utility host is not adopted", c.adopted === "", say(c));

  // MUST-KEEP — a utility portalUrl that lands on a city's self-hosted Accela (rule 5's own predicate
  // refuses the landing; the gate's regex names no such host).
  const u = await run(recipeOf("utility", UTILITY_VANITY, [entry(CITYX_CAP_HOME), stop]));
  check("MUST-KEEP (utility -> self-hosted Accela): no stop at login and no refusal line there (as before the fix)",
    u.login.ok && u.refusalsAtLogin.length === 0, say(u));
  check("MUST-EXCLUDE (utility -> self-hosted Accela): the recipe's goto there is refused in the gate's usual words and never requested",
    !!u.fill && !u.fill.ok && u.fill.message.includes("goto leaves the recipe's portal (cityelectric.localhost) for cityx.localhost — stopped rather than followed")
      && !u.hits.includes("permits.cityx.localhost/CitizenAccess/Cap/CapHome.aspx"), say(u));
  check("cross-check (utility -> self-hosted Accela): the permit host is not adopted", u.adopted === "", say(u));

  // MUST-KEEP — no redirect: main's run and main's words.
  const d = await run(recipeOf("ahj", LANDED, [entry(DASHBOARD), fillProject, stop]));
  check("MUST-KEEP (no redirect): the run passes as on main, no landing note",
    d.login.ok && !!d.fill?.ok && d.box === "Smoke 231" && !/landed on/.test(d.gotoNote) && !d.notes.some((n) => /landed on/.test(n)) && d.adopted === "", say(d));
  const e = await run(recipeOf("ahj", LANDED, [entry(DASHBOARD), fillProject, entry(THIRD), stop]));
  check("MUST-KEEP (no redirect): a third site is refused in main's exact words",
    !!e.fill && !e.fill.ok && e.fill.message.includes("goto leaves the recipe's portal (accela.localhost) for elsewhere.localhost — stopped rather than followed")
      && !e.hits.some((h) => h.startsWith("elsewhere.localhost")), say(e));
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} landed-portal check(s) FAILED.`); process.exit(1); }
console.log("\nAll landed-portal checks passed (real Chromium, replica redirects, real sign-in forms).");
process.exit(0);
