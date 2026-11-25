// LOGIN HEALTH IS KEYED ON THE LOGIN'S STATUS, NOT ON THE WORDING OF THE LEARN'S MESSAGE.
//
// The learn-side writer (backend/src/autoLearn.ts, the ONE caller of recordLoginOutcome that
// coverageReport.test pins) used to regex the whole learn message: "still on the login form" marked
// the credential stale, "review|advance|fill" anywhere in the text cleared it, and anything else
// wrote nothing. City of Bend (CityView) showed what that misses: the submit pick clicked a
// disclosure legend, the form never posted, and the message said "an unfinished two-step login" —
// nothing was written, and nothing COULD be, because the page was never the portal's answer.
//
// The learn now carries LearnResult.login = { status, detail } and the writer keys on that. This
// file drives the REAL autoLearnPortal with only the browser stubbed (setAutoLearnSeamsForTests)
// and reads the credential row through the real store:
//
//   (1) login logged_in, learn failed LATER with neutral wording  -> ok:true (a stale mark clears);
//   (2) still_on_login, detail.cause toggle_click (never posted)  -> NOTHING written;
//   (3) still_on_login, detail.cause refused_banner               -> ok:false, note = the banner;
//   (4) a result with no `login` field (an older bundle shape)    -> the legacy wording path;
//   (5) start login logged_in, a MID-RUN login on another host refused -> the START portal's row
//       reads ok:true (its credential DID work; the other host's refusal is not this row's).
//
// BITE (backend/src/autoLearn.ts at f280d056, message-keyed): (1) stays stale — the neutral
// message cleared nothing; (3) writes the whole message as the note; (5) marks the start portal's
// working credential stale. (2) wrote nothing on the old code too — the toggle message matches no
// refusal wording — so its bite is the naive keying this file forbids: `status === "still_on_login"
// → ok:false` turns (2) red. (4) is the over-correction guard and passes on both, by design.
//
// Run: npx tsx backend/test/learnLoginHealth.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("learn-login-health");
const { db, client } = fx;
const autoLearn = await import("../src/autoLearn");
const creds = await import("../src/portalCredentials");

// The portal under learn, and the client's login for exactly that host (the real write path).
const portalUrl = "https://permits.bendcity.example/Portal/Account/Logon";
creds.createPortalCredential(db, client.id, { portalType: "OR · CityView", portalUrl, username: "permits@example.test", password: "not-a-real-secret" });
const row = () => creds.listPortalCredentials(db, client.id).find((c) => c.portalUrl === portalUrl)!;

// The stub learn: every result FAILED at or after the login (ok:false, no pages), so no recipe is
// ever promoted and a later case never lands in the protect-complete path.
let nextLearn: Record<string, unknown> = {};
const failedLearn = { ok: false, portalName: "Stub Portal", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async () => ({ ...failedLearn, ...nextLearn })) as never });

async function learnWith(result: Record<string, unknown>): Promise<void> {
  nextLearn = result;
  await autoLearn.autoLearnPortal(db, fx.newProject(), { scope: "ahj", portalUrl, createdBy: "operator" });
}
// The adapter's wording for a login that did not succeed: `${portalName}: ${performLogin.message}`.
const loginMessage = (m: string) => `Stub Portal: ${m}`;
const TOGGLE_MESSAGE = "The submit click did not post the form (the control clicked was a panel toggle: <legend role=button aria-expanded=true→false>); no request left the browser and the login panel toggled on the same page. The stored username/password was never presented, so nothing is known about it. An engine fault in the submit pick — record this portal's login control manually.";
const BANNER = "Invalid email or password";
const BANNER_MESSAGE = `Still on the login form after submitting — the portal answered "${BANNER}" — the stored username/password was likely rejected. Verify the credential for this portal, then retry.`;
const LEGACY_REFUSED = "Still on the login form after submitting — the stored username/password was likely rejected.";

await check("setup: the learn resolves THIS credential for the portal (so 'nothing written' can never be 'no credential')", async () => {
  const cred = creds.getDecryptedCredentialForPortal(db, client.id, "AHJ", portalUrl);
  assert.ok(cred && cred.username === "permits@example.test", "the stored login must be the one the learn binds");
  assert.equal(row().stale, false);
});

await check("(1) login logged_in, learn failed later with neutral wording -> ok:true, a stale mark clears", async () => {
  creds.recordLoginOutcome(db, client.id, portalUrl, { ok: false, note: LEGACY_REFUSED });
  assert.equal(row().stale, true, "precondition: the row starts stale");
  await learnWith({
    message: loginMessage("Stopped: the signed-in landing page offers no application entry."),
    login: { status: "logged_in", detail: { submittedVia: "button", posted: true } },
  });
  assert.equal(row().stale, false, "the portal accepted the password — the stale mark must clear even though the learn failed afterwards");
  assert.match(String(row().lastLoginNote), /login accepted/i);
});

await check("(2) a submit click that never posted the form writes NOTHING — the page is not the portal's answer", async () => {
  creds.recordLoginOutcome(db, client.id, portalUrl, { ok: true, note: "sentinel: the last real verdict" });
  const before = row();
  await learnWith({
    message: loginMessage(TOGGLE_MESSAGE),
    login: { status: "still_on_login", detail: { submittedVia: "button", posted: false, cause: "toggle_click", clicked: { tag: "legend", role: "button", id: "", name: "", type: "", ariaExpanded: "true", inForm: true } } },
  });
  const after = row();
  assert.equal(after.stale, false, "a never-presented password must not be marked stale");
  assert.equal(after.lastLoginNote, before.lastLoginNote, "the row must be left EXACTLY as it was — note included");
  assert.equal(after.lastLoginOkAt, before.lastLoginOkAt);
  assert.equal(after.lastLoginFailedAt, before.lastLoginFailedAt);
});

await check("(3) a refusal banner beside the form -> ok:false with the portal's own words as the note", async () => {
  await learnWith({
    message: loginMessage(BANNER_MESSAGE),
    login: { status: "still_on_login", detail: { submittedVia: "button", posted: true, banner: BANNER, cause: "refused_banner" } },
  });
  assert.equal(row().stale, true, "the portal refused the password — the row must read stale");
  assert.equal(row().lastLoginNote, `the portal answered "${BANNER}"`, "the note is the banner, not the learn's whole sentence");
});

await check("(4) a result with no `login` field (an older bundle) still takes the wording path", async () => {
  creds.recordLoginOutcome(db, client.id, portalUrl, { ok: true, note: "login accepted" });
  await learnWith({ message: loginMessage(LEGACY_REFUSED) });
  assert.equal(row().stale, true, "the legacy wording still marks the credential stale");
  assert.match(String(row().lastLoginNote), /still on the login form/i);
  creds.recordLoginOutcome(db, client.id, portalUrl, { ok: true, note: "login accepted" });
  await learnWith({ message: loginMessage("Stopped: nothing to review here."), ok: false, pageCount: 2 });
  assert.equal(row().stale, false, "the legacy reached-portal reading still clears it");
});

await check("(5) the start login worked; a MID-RUN login on another host was refused -> the START row reads ok:true", async () => {
  // The adapter embeds the mid-run performLogin message in the learn message
  // ("Stopped: the mid-run login at <host> did not succeed (still_on_login): Still on the login
  // form …"). The old wording path read that as THIS portal's refusal and marked a working
  // credential stale. The start host's credential did work: its row says so. The other host's
  // refusal lands on no row here (named as an open item, not hidden).
  creds.recordLoginOutcome(db, client.id, portalUrl, { ok: false, note: "sentinel: stale before the run" });
  assert.equal(row().stale, true);
  await learnWith({
    message: loginMessage(`Stopped: the mid-run login at sso.bendcity.example did not succeed (still_on_login): ${LEGACY_REFUSED}`),
    login: { status: "logged_in", detail: { submittedVia: "button", posted: true } },
    pageCount: 3,
  });
  assert.equal(row().stale, false, "the start portal accepted its password; another host's refusal is not this row's verdict");
  assert.match(String(row().lastLoginNote), /login accepted/i);
});

finish("learn-login-health");
