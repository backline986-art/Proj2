// #231 — THE SITE THE RECIPE'S OWN PORTAL URL LANDED ON IS THE RECIPE'S PORTAL FOR THE RUN, AND
// NOTHING ELSE IS. Real Chromium, the adapter's real login() (openPortal, the portal goto, the
// sign-in) and fillApplication.
//
// Live (City of Meridian, Accela, replay sweep 2026-11-14): recipe.portalUrl is the vanity host
// https://citizenportal.meridiancity.org/CitizenAccess/, which redirects to
// https://aca-prod.accela.com/meridian/Default.aspx. Replay opened portalUrl, landed and SIGNED IN on
// aca-prod.accela.com, then refused the recipe's step 0 { goto
// https://aca-prod.accela.com/MERIDIAN/Dashboard.aspx, note "entry url" }: "goto leaves the recipe's
// portal (meridiancity.org) for accela.com — stopped rather than followed".
//
// REPLICA (no live portal): one local server answering by Host header; Chromium resolves every
// *.localhost name to loopback, so each name below is its own site to siteOfUrl.
//   citizenportal.meridiancity.localhost/CitizenAccess/  302 -> aca-prod.accela.localhost/meridian/Default.aspx
//   aca-prod.accela.localhost                            the landed portal (signed in: a "Log out" link)
//   elsewhere.localhost                                  a third site no goto may reach
//   permits.cityof.localhost/apply/                      a PERMIT portalUrl that 302s to ->
//   pgenm.powerclerk.localhost                           a utility (PowerClerk) portal
//
// MUST-PASS: the Meridian shape replays past step 0 (the goto to the landed site) and fills the
//   dashboard's box; the landing is named in the run's notes.
// MUST-EXCLUDE: after that landing, a goto to a third site is refused, named, and never requested.
// MUST-EXCLUDE: a permit recipe whose portalUrl lands on a PowerClerk host stops at login, named,
//   before signing in; the host is not adopted; driven on anyway, the recipe's goto there is still
//   refused by the track rule and the PowerClerk host sees no request beyond the redirect's landing.
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

const hits: string[] = [];
let port = 0;
const at = (host: string, path: string): string => `http://${host}:${port}${path}`;
const page = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><div id="nav"><a href="/Logout.aspx">Log out</a></div>${body}</body></html>`;
const server = http.createServer((req, res) => {
  const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  const url = new URL(req.url || "/", "http://x");
  hits.push(`${host}${url.pathname}`);
  const html = (body: string): void => { res.writeHead(200, { "content-type": "text/html" }); res.end(body); };
  if (host === "citizenportal.meridiancity.localhost" && /^\/CitizenAccess\/?$/i.test(url.pathname)) {
    res.writeHead(302, { location: at("aca-prod.accela.localhost", "/meridian/Default.aspx") }); res.end(); return;
  }
  if (host === "aca-prod.accela.localhost" && /^\/meridian\/Default\.aspx$/i.test(url.pathname)) {
    html(page("Accela Citizen Access", `<h2>Welcome to the City of Meridian</h2>`)); return;
  }
  if (host === "aca-prod.accela.localhost" && /^\/meridian\/Dashboard\.aspx$/i.test(url.pathname)) {
    html(page("Accela Citizen Access", `<h2>Dashboard</h2><label for="proj">Project Name:</label> <input id="proj" type="text">`)); return;
  }
  if (host === "elsewhere.localhost") { html(page("Elsewhere", `<label for="x">Project Name:</label> <input id="x" type="text">`)); return; }
  if (host === "permits.cityof.localhost" && /^\/apply\/?$/i.test(url.pathname)) {
    res.writeHead(302, { location: at("pgenm.powerclerk.localhost", "/MvcAccount/Login") }); res.end(); return;
  }
  if (host === "pgenm.powerclerk.localhost") { html(page("PowerClerk", `<h2>Interconnection projects</h2>`)); return; }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
port = (server.address() as { port: number }).port;

const VANITY = at("citizenportal.meridiancity.localhost", "/CitizenAccess/");
const LANDED = at("aca-prod.accela.localhost", "/meridian/Default.aspx");
const DASHBOARD = at("aca-prod.accela.localhost", "/MERIDIAN/Dashboard.aspx");
const THIRD = at("elsewhere.localhost", "/apply");
const PERMIT_VANITY = at("permits.cityof.localhost", "/apply/");
const PC_HOME = at("pgenm.powerclerk.localhost", "/MvcProjects/Home");

const recipeOf = (scopeType: "ahj" | "utility", portalUrl: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "landed-portal-site", scopeType, profileKey: "id|city of meridian|idaho power", state: "ID", ahj: "City of Meridian", utility: "",
  portalPlatform: "accela", portalUrl, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", discipline: "electrical", steps,
} as unknown as PortalRecipe);
const entry = (url: string): RecipeStep => ({ action: "goto", value: url, note: "entry url" });
const fillProject: RecipeStep = { action: "fill", selector: { label: "Project Name:" }, field: "projectName", note: "Project Name:" };
const stop = { action: "stopForReview" } as RecipeStep;

type Outcome = {
  login: { ok: boolean; message: string }; fill: { ok: boolean; message: string; data?: Record<string, unknown> } | null;
  adopted: string; url: string; box: string; hits: string[]; notes: string[]; refusals: string[];
};
async function run(recipe: PortalRecipe, opts: { driveOnAfterRefusedLogin?: boolean } = {}): Promise<Outcome> {
  hits.length = 0;
  const adapter = new RecipeAdapter(recipe, { projectName: "Smoke 231" }, {});
  try {
    const login = await adapter.login({ headless: true }) as { ok: boolean; message: string };
    const adopted = String((adapter as unknown as { landedPortalSite?: string }).landedPortalSite ?? "");
    let fill: Outcome["fill"] = null;
    if (login.ok || opts.driveOnAfterRefusedLogin) {
      try { fill = await adapter.fillApplication({} as ProjectRecord) as Outcome["fill"]; } catch (e) { fill = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
    }
    const pg = (adapter as unknown as { page: Page | null }).page;
    const url = pg ? pg.url() : "";
    const box = pg ? await pg.evaluate(() => (document.querySelector("input") as HTMLInputElement | null)?.value ?? "(none)").catch(() => "(unreadable)") : "(no page)";
    const data = (fill?.data ?? {}) as { agingNotes?: string[] };
    return { login, fill, adopted, url, box, hits: [...hits], notes: data.agingNotes ?? [], refusals: [...adapter.guardRefusals] };
  } finally {
    await adapter.close().catch(() => null);
  }
}
const say = (o: Outcome): string => `login=${o.login.ok}:${o.login.message.slice(0, 220)} | fill=${o.fill ? `${o.fill.ok}:${o.fill.message.slice(0, 260)}` : "(not run)"} | adopted=${o.adopted || "(none)"} url=${o.url} box=${o.box} | hits=${JSON.stringify(o.hits)} | notes=${JSON.stringify(o.notes.filter((n) => /landed/.test(n)))} | refusals=${JSON.stringify(o.refusals)}`;

try {
  // MUST-PASS — the Meridian shape.
  const a = await run(recipeOf("ahj", VANITY, [entry(DASHBOARD), fillProject, stop]));
  check("MUST-PASS (Meridian): the run signs in where portalUrl landed", a.login.ok && /aca-prod\.accela\.localhost/.test(a.url), say(a));
  check("MUST-PASS (Meridian): step 0's goto to the landed site runs and the dashboard's box is filled",
    !!a.fill?.ok && a.box === "Smoke 231" && a.hits.includes("aca-prod.accela.localhost/MERIDIAN/Dashboard.aspx"), say(a));
  check("MUST-PASS (Meridian): the landing is named in the run's notes", a.notes.some((n) => /meridiancity\.localhost\) landed on accela\.localhost/.test(n)), say(a));

  // MUST-EXCLUDE — a third site after that landing.
  const b = await run(recipeOf("ahj", VANITY, [entry(DASHBOARD), fillProject, entry(THIRD), stop]));
  check("MUST-EXCLUDE (third site): the goto is refused, named",
    !!b.fill && !b.fill.ok && /replay safety gate refused: goto leaves the recipe's portal \(meridiancity\.localhost, landed on accela\.localhost\) for elsewhere\.localhost/.test(b.fill.message), say(b));
  check("MUST-EXCLUDE (third site): the third site is never requested", !b.hits.some((h) => h.startsWith("elsewhere.localhost")), say(b));

  // MUST-EXCLUDE — a permit portalUrl that lands on a PowerClerk host.
  const c = await run(recipeOf("ahj", PERMIT_VANITY, [entry(PC_HOME), stop]), { driveOnAfterRefusedLogin: true });
  check("MUST-EXCLUDE (permit -> PowerClerk): login stops, named, before signing in",
    !c.login.ok && /replay safety gate refused: the recipe's portal \(cityof\.localhost\) landed on powerclerk\.localhost — a permit recipe may not open a utility \(PowerClerk\) portal/.test(c.login.message) && /before signing in/.test(c.login.message), say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): the utility host is not adopted", c.adopted === "", say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): recorded as a refusal", c.refusals.some((r) => /^REFUSED goto \(open the recipe's portal\): .*powerclerk\.localhost/.test(r)), say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): driven on anyway, the recipe's goto there is refused by the track rule",
    !!c.fill && !c.fill.ok && /replay safety gate refused: a permit recipe may not open a utility \(PowerClerk\) portal: powerclerk\.localhost/.test(c.fill.message), say(c));
  check("MUST-EXCLUDE (permit -> PowerClerk): the PowerClerk host saw only the redirect's landing",
    c.hits.filter((h) => h.startsWith("pgenm.powerclerk.localhost")).join(",") === "pgenm.powerclerk.localhost/MvcAccount/Login", say(c));

  // MUST-KEEP — no redirect: main's run and main's words.
  const d = await run(recipeOf("ahj", LANDED, [entry(DASHBOARD), fillProject, stop]));
  check("MUST-KEEP (no redirect): the run passes as on main, nothing adopted, no landing note",
    d.login.ok && !!d.fill?.ok && d.box === "Smoke 231" && d.adopted === "" && !d.notes.some((n) => /landed on/.test(n)), say(d));
  const e = await run(recipeOf("ahj", LANDED, [entry(DASHBOARD), fillProject, entry(THIRD), stop]));
  check("MUST-KEEP (no redirect): a third site is refused in main's exact words",
    !!e.fill && !e.fill.ok && e.fill.message.includes("goto leaves the recipe's portal (accela.localhost) for elsewhere.localhost — stopped rather than followed")
      && !e.hits.some((h) => h.startsWith("elsewhere.localhost")), say(e));
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} landed-portal-site check(s) FAILED.`); process.exit(1); }
console.log("\nAll landed-portal-site checks passed (real Chromium, replica redirect).");
process.exit(0);
