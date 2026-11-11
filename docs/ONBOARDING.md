# Onboarding — bringing a new solar installer onto the Autopilot

Audience: the person at our company who onboards a new installer. Follow it start to
finish without reading source code. Everything here is a step you perform, a command you
run, or a sentence you say to the customer.

Read first, in this order:

1. `docs/onboarding/INTAKE_CHECKLIST.md` — what to collect from the company, field by field,
   with what breaks when each one is missing.
2. `docs/onboarding/intake-template.json` — the machine-readable shape of that same intake,
   which is what the provisioning script actually consumes.
3. `docs/onboarding/CAPABILITIES.md` — the measured detail behind what we can and cannot do.
4. This file — the runbook that ties them together.
5. `docs/NEM_OPERATOR_RUNBOOK.md` — for the team member who files: what to click on a NEM
   filing, what the tool does after each click, and what to do when a run stops.

If you only remember one thing, remember this: **nothing is filed until a named person says
so.** By default a run stops at the portal's review screen and a person presses submit. The one
other way is Approve & auto-submit: a named person approves exactly that run on the approval
sheet, and the run files it, only if every condition in §7 holds. Every number, promise and
caveat below follows from that.

Last checked against the code on **2026-11-11** for: the Company setup link (§3.4), licences per
state (§1), the service area and Destinations to confirm (§3.5), the go-live check (§4.3), email
filing, the approval sheet and battery jobs (§7), invoices (§7.1) and what we do not do (§2, §9).
The measured portal numbers in §2 and §6 are still the 2026-09-09 counts; they were not re-run
for this revision and say so where they appear.

---

## 0. The shape of the job

The Autopilot takes a plan set and drives the AHJ or utility portal up to that portal's own
review screen, with the application filled. It stops there. A person looks at the filled
application in the browser and presses submit, or a named person approves that one run with
Approve & auto-submit and the run files it under the conditions in §7. Where a person has
recorded that an authority takes its application by email, the "portal" is an email: it is
staged as a draft, and sent by a person or under the same approval (§7).

| Step | Who | Notes |
|---|---|---|
| Parse the plan set into fields | Automation | LLM + deterministic parsers |
| QC the design against the AHJ's adopted codes | Automation | produces findings, does not clear them |
| **Clear the reviewer gate** | **Human** | a blocker finding stops the run until a person clears it |
| Build and fill the AHJ's own PDF forms | Automation | from `ahj_form_templates` |
| Log into the portal | Automation | stored encrypted credentials |
| Walk the application and fill every field | Automation | recipe replay, or a learn run for a new portal |
| **Solve a CAPTCHA or MFA challenge** | **Human** | never automated, under any flag |
| **Sign anything (DocuSign / eSign)** | **Human** | we hold no DocuSign integration; automation may type the notification email, never presses `eSign` |
| **Confirm where each authority takes its filings** | **Human** | one Confirm (or Edit) per city or utility in Destinations to confirm. Nothing files automatically to a destination no named person confirmed (§3.5) |
| **Press the portal's final submit, or send the filing email** | **Human**, or the run a named person approved | stops at review by default. Approve & auto-submit is one person's approval of exactly one run, and it files only when every condition in §7 holds |
| **Pay a portal fee** | **Human** | never automated, under any flag, ever |
| Watch for corrections and status changes | Automation | permit monitor |
| Answer a correction / resubmit | Both | automation refills, a human files again |
| **Cancel the draft applications a learn run leaves in the portal** | **Human, on the customer's side** | learning or benchmarking a portal mints real drafts under their account and nothing of ours deletes them — see §2 |
| **Inspections, completion documents, permission to operate (PTO)** | **Not us** | we file the permit and the interconnection application and follow them to issued / approved. Staff can record the later dates on a job's timeline; nothing requests an inspection or PTO (§2) |

The bolded human rows are not gaps we are closing. They are deliberate. Automation clicking
"Pay $180" or "Submit Application" on a government portal on a customer's licence, unasked, is
the one mistake that ends the business, so the code refuses in several independent places. Do
not promise a customer that any of this changes with a setting: fees, CAPTCHA, MFA and
signatures are never automated, and a submit is clicked only in the run a named person approved.

---

## 0.5 The seven days we promised them

The customer already has this schedule. It is section 2 of the onboarding guide we hand every
new company, and they will hold us to it, so it is the spine of this runbook rather than a
summary of it. Each day below names the section that does the work and the command that
produces the deliverable.

| Day | What the guide promises them | What you actually do | Where |
|---|---|---|---|
| **D0** | **Kickoff** — confirm jurisdictions and portals; agree who handles fees, portal passwords and setup-draft cleanup | Take the intake packet; get the three agreements in writing | §1, §2 |
| **D1-2** | **Setup** — load company and licence details, store portal credentials encrypted | Create the client and send its Company setup link (the client fills in its own block and you accept the answers), or fill the intake file outside the repo and run `onboard-company.ts`. Either way, mint the secure credential link for the logins | §3, §3.4, §5 |
| **D1-3** | (ours, not in the guide) | Record the service area, confirm each authority's filing destination in Destinations to confirm, and run the go-live check before any email with a link goes to them | §3.5, §4.3 |
| **D2-3** | **Coverage report** — "which of your jurisdictions are ready now, which need a supervised first run, and which can't be filed yet" | `npm run coverage:report -- --client <id> --jurisdictions "…"` | §4 |
| **D3-6** | **Portal verification** — "we verify each portal with your credentials on a real project, one at a time" | A learn run per portal, watched, serialised | §6 |
| **D7** | **Ready** | Nothing new — this is the day the coverage report's SUPERVISED FIRST RUN column has emptied | §4 |

**Two items block everything else, and the guide says so in those words: their contractor
licences and their portal logins.** Chase both on D0. Everything else on the intake can
arrive on D1 without stopping the clock; those two cannot. A licence is needed for every state
they file in (§1): an Oregon job refuses to stage without the CCB number, and in any other
state a missing licence leaves the licence slot blank on the application. The logins are a gate
you cannot route around, because **we do not create
portal accounts** — a person at their company registers each one on the portal's own site,
and several portals email a code to do it.

**The three D0 agreements, which are the ones that get skipped.** Each is a real commitment in
the guide, each has a home in the data now, and each becomes somebody's bad surprise if it is
left to the first filing:

1. **Fees — agreed PER PORTAL, not per company.** "A payment method on file in your portal
   account, or a person on your side completing payment. Mailed-check fees (Ameren Illinois,
   for example) are yours to send." One installer really is card-on-file in one portal, a
   person who pays in another, and a cheque in the post for the third, so a single
   company-level answer is wrong for at least two of them. Record it as each credential's
   `feeResponsibility` (`card-on-file` / `customer-pays` / `mailed-check` / `keelix-pays`).
   The coverage report prints `NOT AGREED` per portal until you do. Recording it authorises
   nothing: automation never pays a portal fee under any value of it.

   **Have the conversation over a number.** "Who pays the fees" is an abstract question until
   somebody says what the fees are, and then it is a short one. `npx tsx scripts/fee-sheet.ts
   --project <id>` (or `--client <id>` for every open project) prints both tracks: the amount,
   the line of the published schedule it fell in, the page it was read from, how sure we are,
   how it is paid, and the agreement you recorded — or `NOT AGREED`, beside the money. The same
   sheet is on the project's dashboard and at `GET /api/projects/:id/fee-sheet`.

   Two things to know before you quote anybody from it. A fee marked **SEEDED** was found by
   research and **nobody has checked it** — verify it against the jurisdiction's own page
   first; `--research` spends an LLM call and lands exactly that kind of number. And a fee we
   do not know prints **UNKNOWN**, never `$0.00`: zero is an answer ("this utility charges
   nothing"), unknown is the absence of one, and a customer gets invoiced off the difference.
2. **Portal passwords — they tell us the day they change one.** Make it an obligation in
   writing. We cannot detect a rotation; the first sign is a failed filing, and we then stop
   trying that portal so the account does not get locked. See §2 and §6.
3. **Setup-draft cleanup — who cancels the drafts we leave.** Every live-portal run mints a
   real draft application under their account, and nothing of ours removes it. We flag each
   one: `npx tsx scripts/draft-ledger.ts` prints every live portal touch we have recorded,
   by host and by account, with any portal-assigned reference. That ledger is the list you
   hand whoever agreed to do the cancelling. Agree WHO at kickoff, not after the sweep.

---

## 1. What we need from the company before we start

The full list, with the exact field names and why each one matters, is
`docs/onboarding/INTAKE_CHECKLIST.md`. Do not retype it here or in an email —
it drifts, and then two customers get provisioned differently. The client can answer most of it
itself on its Company setup link (§3.4); the checklist is still what you read to know why each
answer matters.

Two items on that checklist BLOCK everything else, so chase them first:

- **The contractor licences, one per licence per state they file in** (`stateLicenses`: state,
  type, number, expiry, and the holder's name for a person's licence). Each number goes only
  in a slot that asks for that type, in that state — never another state's number in a
  "contractor licence" box. The types are a fixed list (contractor, electrical contractor,
  construction supervisor, home improvement contractor, solar contractor, master electrician,
  business registration); the Clients screen and the Company setup page both offer it.
  What a missing one costs depends on the state:
  - **Oregon:** the named columns are Oregon's licences (`ccbLicenseNumber`,
    `electricalLicenseNumber`, `electricianLicenseNumber`). Without the CCB number, staging
    refuses with a 409 and the message `Submitting client "X" has no CCB license number on
    file`.
  - **Any other state:** nothing refuses. The submit gate shows a warning naming the permit
    whose licence is missing, the slot stays blank on the application, and the AHJ rejects it
    days later. `onboarding-readiness.ts` reports it per state before that happens (§4.1), and
    `onboard-company.ts` refuses a run when no licence is on file at all, or when a state it
    can see (the licence state, or any state the company holds a licence in) has no contractor
    licence.
- **The portal logins.** See §5 — there is a safe way to receive these and several unsafe ways.

`licenseState` is still collected: it is the state that issued the Oregon-style named columns
and the fallback the readiness check uses when no jurisdiction is in scope. A company that
files in two states is the normal case, which is why the per-state list exists.

The guide marks several other intake items REQUIRED and says setup stops until we have them.
Two of those are easy to nod past because they look like duplicates of fields we already hold,
and are not:

- **The shared inbox for our updates** (`updatesInbox`). "Where we send confirmations, status
  updates and corrections. A shared inbox, not one person's." It is deliberately NOT
  `businessEmail` — that one is the installer address that goes **on the application**, which
  is where the AHJ mails its corrections. One is ours to write to; the other is the agency's.
- **The billing contact** (`billingContactEmail`) — who receives our invoices, which is
  routinely not the person who receives the permit correspondence.

Everything else on the checklist — legal business name, business address, EIN, bond and
insurance carriers, authorized signer, standard disconnect make/model — is not enforced by
any error. It feeds straight into the portal fields. **A blank there becomes a blank portal
field, which is a rejected filing rather than an error message.** That is the quiet failure
mode of this whole process. Collect the licence/business block completely, not "enough to
get started".

**Also ask where they work** (`serviceArea`: each state, city or county, and utility). It
decides nothing about any job, but it is what lets you confirm their filing destinations
before their first job arrives (§3.5).

---

## 2. The honest conversation to have up front

Have this conversation before provisioning, not after the first filing stalls. The customer
is buying a filing service with a human in the loop. If they think they are buying a robot
that files permits while they sleep, the first MFA prompt reads as a broken product.

Say these things plainly:

**"We stage the application, and a named person decides it is filed."** The run
leaves the filled application on the portal's review screen and the project lands in the
`awaiting_human_submit` state. A person opens it, reads the filled application, and files it.
The other route is Approve & auto-submit: one of our team reads the approval sheet (what is
about to be filed, where, with which attachments, and every open review item) and approves that
one run, and the run then clicks the portal's submit itself. That approval is per run, it is
recorded under the approver's name, and it files only where a person has confirmed the
destination and the server's switch is on (§7). There is no setting that makes filing
unattended, and do not describe one.

**"We file the permit and the interconnection application. We do not do what comes after."**
No inspection scheduling, no completion or as-built uploads, no permission-to-operate request.
The job's timeline has places for staff to record those dates, but nothing in the product
requests an inspection or PTO. Never promise it.

**"We never solve CAPTCHA or MFA, and we never pay a fee."** If their portal account
challenges a new device, the run pauses and waits for a human at that browser. If the portal
wants a card, the run stops and says so.

**"Staged is not filed."** When we say a filing is staged, we mean: the fields are in, the
review screen is up, nothing has been submitted to a government body. The customer's permit
clock has not started.

**"Teaching a portal leaves real draft applications in your account, and nothing on our side
deletes them."** Say this one out loud; it is the disclosure most likely to surprise them
later. A learn run drives their live portal account under their licence and gets as far as the
portal's review screen, which on most portals means the portal has already minted a draft
record with a real intake number. It is never submitted — automation does not click final
submit — but it exists, it is visible in their account and on some portals to the authority's
staff as well, and **no code path of ours removes it.** Real examples are on record: the Miami
benchmark runs left drafts
on the live account, one carrying intake number `BD26-021147-001` (`docs/HANDOFF.md`, the
benchmark operator note). It compounds: the replay self-test re-runs the same live portal and
can create a SECOND draft (`backend/src/autoLearn.ts:1155`), so a single
`--repeat 3 --self-test` sweep can leave six. **A human on their side has to cancel the junk
drafts.** Agree up front who that is, and warn them before every learn run on a portal where a
draft is visible to the reviewing authority.

What we DO owe them here is the list, and the guide promises exactly that — "we'll flag each
one". Every live-portal run writes an append-only ledger entry **before the browser opens**,
so a run that dies half way is still recorded; read it with `npx tsx scripts/draft-ledger.ts`
(`--host <host>`, `--since <date>`). It is not pruned, unlike the run bundles under
`data/learn-runs/`, which are — so the ledger is the only durable record of what we left
behind. It holds no secret: an account appears as its username reference and no field value
is copied in. What it cannot do is see backwards: runs that predate it are not in there.

**"When you rotate a portal password, you have to tell us the same day."** Make this an
obligation in writing, because the failure mode is silent and it is theirs, not ours:

- We do not detect a rotation. We find out when a filing hits the login form and fails.
- That refusal marks the credential stale, and the stale flag makes the benchmark **skip that
  portal entirely** until a person fixes it — correct behaviour (repeated attempts lock real
  accounts), but it means the portal quietly leaves the fleet rather than erroring loudly.
- The flag does not clear when they send a new password. It clears only when a login actually
  succeeds. See §6 for the exact sequence, which is not the one the tool's own output prints.
- This is not hypothetical: **12 of our 68 portal hosts are sitting in that state right now**
  (counted 2026-09-09 against the live DB; the number moves with every sweep). Each one is a
  portal we cannot measure or file through until someone re-supplies a login.

**"Even the one portal we have proven end to end still needs two human steps."** Do not let
"proven repeatable" be heard as "hands off". On Ameren Illinois NEM (PowerClerk), our only
repeat-measured portal:

- The application pages in our own learn bundle carry the portal's notice
  *"Multi-Factor Authentication Required — Your account must have Multi-Factor Authentication
  enabled in order to perform this operation. You can enable Multi-Factor Authentication from
  the My Account page."* Our runs did not pause on it — the bundle on disk records
  `pauseReason: null` — so it gates an operation past the point where automation stops, which
  means it gates **the human's** step. The person who submits needs MFA enabled on that account
  and their second factor to hand. Confirm that with the customer before promising a filing
  there; a submit-time MFA wall discovered by the person holding the mouse is a bad surprise.
- The $50 Level 1 fee is **a mailed paper check**, within 15 business days of submission, and
  the application is not reviewed until the check lands (`docs/IL_ONBOARDING.md:32`). There is
  no online payment to automate even in principle.

So the best case we can demonstrate today is: automation fills eight pages, then a human with
an MFA-enabled account submits, then someone posts a cheque.

**"You are the first."** As of this revision the process has not been run end to end for a
paying company; the measured numbers below come from our own benchmark fixture client in
`org-default`. Say it to the customer in whatever register suits the relationship, but do
not skip it internally: **the first customer is the first execution of this runbook.** Budget
for it. Expect a step in here to be wrong, and fix this document when it is.

**Portal coverage, with the honest denominator (counted 2026-09-09, not re-run since).** Do not
round these up, and do not quote them without the denominator — `docs/onboarding/CAPABILITIES.md` carries the per-platform detail
and the exclusions.

| Measurement | Number | What it does NOT mean |
|---|---|---|
| Distinct portal hosts we hold credentials for | 68 | not 68 working portals |
| Hosts actually measured in the last sweep | 54 | 14 excluded: 11 stale-credential hosts, 3 with no benchmark address |
| Stale-credential hosts TODAY (2026-09-09) | 12 of 68 | the exclusion count above is the figure at the last sweep; it moves every run — recount before quoting either |
| Of those measured, log in successfully | 26 of 54 (48%) | **not 26 of 68** |
| Of those, record a recipe that fills real fields | 17 | logging in is not filling |
| Proven repeatably end to end (learn → review → replay → review) | **exactly 1** | Ameren Illinois NEM on PowerClerk, 3/3 attempts, self-test passing |

One portal has a repeat-measured success rate. Every other number above is a single attempt
on one build. Say "one portal is proven repeatable; the rest are measured once" rather than
implying a fleet reliability figure. If the customer asks for an SLA per portal, the answer
is that we can produce one after `--repeat N` runs against their portals, not before.

**The caveat that matters most for a new customer.** If a filing goes to an AHJ we have never
touched, and there is no recorded recipe and no known portal URL for it, the stage stops and
says so: *"No portal URL is known for … so nothing was staged."* Nothing opens and nothing is
marked staged. (It used to report a successful stage against a simulated portal; that now
happens only when `MOCK_PORTAL=1` is set for a rehearsal, and the go-live check shows that
switch red, §4.3.) What this means for the customer is a delay, not a false success: somebody
has to record that portal before their first filing there. §6 and §8 tell you how.

**Two questions their security or legal reviewer will ask, answered before they ask.** A
company handing over government-portal logins gets a review, and both of these are in §5 with
the detail: (1) their live portal SESSIONS — cookies and saved logins — are isolated per
customer at `portal-profiles/<clientId>/<portalType>/` and sit there **unencrypted**, outside
`SESSION_ENCRYPTION_KEY`; (2) offboarding is now a real command —
`npx tsx scripts/offboard-company.ts <clientId> --confirm <clientId>` removes their
credentials, sessions, projects, documents and homeowner records — and §5 carries what it
does, what it deliberately leaves, and what is still manual. Read both before you promise
anything about data handling.

---

## 3. Provisioning the company

Standard onboarding creates ONE thing: a `clients` row inside our own org
(`DEFAULT_ORG_ID = "org-default"`). That is the whole service-bureau model — we hold the login,
they are the company the work is for.

Spelled out, because every other combination is a wrong turn:

| Standard onboarding creates | Standard onboarding does NOT create |
|---|---|
| one `clients` row in `org-default`, carrying the licence/business block | **no org** — no new tenant, no `org_entitlements` row, no product grant |
| one `portal_credentials` row per portal login, encrypted | **no login for the customer** — nobody at the customer's company signs in to our tool |
| optionally a `client_portal_identities` row per portal | **no user row for them** — see §3.2; the customer does not need one to be filed for |

**The customer never logs in to our software.** They send us plan sets and logins; we stage;
a named person files. That is the complete path to a filed permit, and it needs exactly the one
client row. What they do get is a set of no-login pages, each opened by a link we send: the
Company setup page (§3.4), the one-time login page (§5), the job intake page and the status
page. A link is not an account: it reaches one client's own page and nothing else.

**Do not create an org for them, and do not let a request for "their own dashboard" turn into
one.** An org is the tenant that LOGS IN, and that lane is a documented dead end today — not
"unpolished", dead. Concretely:

- The only org-creation surfaces are `POST /api/orgs` (superadmin-only, curl-only, no UI) and
  an explicit `org.createTenant: true` in an intake file. Nothing else creates an org — in
  particular an `org` block naming a company but omitting `createTenant` is ignored with a
  warning, and the client lands in `org-default`.
- `POST /api/orgs/:id/users` is the only route that creates a user who can actually sign in,
  and it writes the role as a **hardcoded SQL literal `'operator'`** (`backend/src/server.ts`,
  the INSERT at ~line 919). There is no parameter for it.
- There is **no role-elevation route**. `updateUser` is the only writer of `role` anywhere, and
  it requires a signed-in admin actor — which the new org does not have and cannot get. The
  only way up is raw SQL against the database, deliberately, by us.
- There is **no password-reset or set-password route** anywhere in the API. Hand a wrong
  password to a tenant and the only fix is raw SQL.
- `requireAdmin` demands an admin role **and** that the caller's own org holds the `autopilot`
  product, so administration is structurally the operator's org, never a tenant's.
- And a tenant granted only `permit_reviewer` / `form_filler` can never stage at all:
  `autopilot` is the `wildcard` product that unlocks the staging surface, and it is
  `apiKeyAuth: false`, so it is not reachable with an API key either.

Net: an org created for a customer can never get its own admin, so it can never manage its own
users, credentials or products. If a customer genuinely needs their own login, **stop and
escalate** — it is a product decision and engineering work, not a runbook step.

### 3.1 Preconditions

Check both before you run anything.

| Precondition | How to check | Why |
|---|---|---|
| `SESSION_ENCRYPTION_KEY` is a real value | `curl -s localhost:4173/health` → `config.sessionKeySet: true`, status not `degraded` | Storing a portal credential THROWS without it. An unedited `.env.example` placeholder counts as missing. |
| `AUTOPILOT_DB_PATH` points at the live DB | it is in `.env`; the scripts default to `backend/data/autopilot.sqlite` | A script with the wrong path silently provisions into a scratch database |

If `/health` reports `SESSION_ENCRYPTION_KEY is unset or default`, stop. Fix the key before
you touch credentials. And if a key already exists, **do not change it** — rotating it without
`npm run rekey:credentials` makes every stored login permanently unreadable, and the failure is
silent (the symptom is "no stored credential for this client", never a crypto error).

### 3.2 Fill the intake file — outside the repo

`scripts/onboard-company.ts` creates the client row, writes the licence/business block, and
attaches the portal credentials. It reads one JSON intake file:
`docs/onboarding/intake-template.json` is the template.

**Copy it out of the repo before you type a real secret into it.** A filled intake file
contains live portal passwords in plaintext, and out of the repo is the rule:

```
cp docs/onboarding/intake-template.json ~/intake/cascade-ridge.json
```

`.gitignore` is the net under that rule, not a substitute for it. It covers `intake/` at any
depth, any filename containing `intake`, every `.json` at the repo root, and every `.json`
under `docs/` — with this one template negated back in so it stays tracked. Verify rather than
trust: `git check-ignore -v <your file>` prints the pattern that caught it, and silence means
nothing did. A copy saved somewhere else entirely (`backend/cascade-ridge.json`) is still
committed by the next `git add -A`.

The script will also print a blank of its own, which is the copy that cannot drift from the
code that reads it:

```
npx tsx scripts/onboard-company.ts --example > ~/intake/cascade-ridge.json
```

Then fill it in. What matters as you do:

- **Omit the whole `org` block.** No `org` block means "a `clients` row in our existing tenant,
  `org-default`" — the service-bureau lane of §3, and the complete path to a staged filing.
  Naming an org is the escalation case above; the template's own comment on that block says the
  same thing. If you are unsure, omit it: adding an org later is a decision, and a client
  created in the wrong tenant is not something this script will move (it never moves a client
  between orgs).
- **Replace every value.** Every string in the template is fake. Nothing should still read
  `EXAMPLE`, `000000`, `.invalid`, or `REPLACE-ME` when you run it.
- **`portalUrl` is the load-bearing field, not `portalType`** — see §5.
- **`notes` is plaintext and LLM-visible.** Operational hints only. No passwords, no security
  answers, no account or meter numbers.
- **Standard onboarding does not need a `users` entry at all — leave the array empty.** The
  customer does not log in (§3). If you do add one, know exactly what you get: `users[].role`
  is **ignored** (the script warns you so), because every user created anywhere in this system
  is an `operator` and `updateUser` — the only writer of `role` — needs a signed-in admin
  actor. Supplying a `password` DOES produce a login that works: the script writes the same
  scrypt `password_hash` that `POST /api/orgs/:id/users` writes, because there is no
  set-password route to fix it with afterwards. So the trap is not "cannot log in", it is
  **"logs in forever as an operator, with no route to change the role and no route to reset the
  password"**. Promotion is raw SQL, by us, deliberately.

### 3.3 Dry run, then the real run

Run the script bare first. Like every CLI here it prints its own usage and exits 1 with no
arguments — **its usage output is the authority on the exact flag names, not this document**:

```
npx tsx scripts/onboard-company.ts
npx tsx scripts/onboard-company.ts ~/intake/cascade-ridge.json --dry-run
```

**Pass the intake path positionally, as above.** `--intake=<path>` also works if you prefer it
(the script's usage lists it), but the positional form is what every example here uses. If you
see usage text and exit 1 when you did pass a path, the path is the thing to check — a
non-existent file is reported by name, and a path you forgot to quote loses everything after
the first space.

A dry run writes nothing and ends with a `DRY RUN — nothing written.` summary. Read it before
proceeding. What you are checking:

- the company name and licence number are exactly right — a typo in the licence number is a
  rejected filing weeks later, not an error now;
- the row count is what you expect: one client, plus one row per portal credential;
- no placeholder strings survived;
- every credential line reports `set` or `missing`, **never a password value**. If a password
  value appears in that output, stop and report it — printing secrets is a bug, not a feature.

Then the real run — the same command with the flag removed. **A real run is the ABSENCE of
`--dry-run`**, so re-read the line before you press enter:

```
npx tsx scripts/onboard-company.ts ~/intake/cascade-ridge.json
```

Two flags worth knowing, both from the script's own usage: `--db <path>` writes to a specific
SQLite file (it overrides `AUTOPILOT_DB_PATH` — useful for a rehearsal against a scratch DB,
dangerous if you forget it), and `--actor=<email>` names you in the audit log instead of the
default `onboard-company script`. Use `--actor` on every real run; a provisioning write with no
attributable human is a bad row to find later.

Move straight to §4. Do not assume it worked because it exited 0 — exit codes in this repo have
lied before; read the output.

Running it twice is safe by design: it re-lands the same rows and will not overwrite anything a
human has verified. To correct a value, fix the intake file and re-run rather than editing the
database by hand.

**Then delete your filled intake file.** The passwords now live encrypted in the database; that
file is a second plaintext copy with no encryption and no access control.

### 3.4 The Company setup link — the client fills in its own block

The alternative to typing the client block yourself. Create the client (a name is enough), open
it on the **Clients** screen and press **Create company setup link** under *Company setup*
(`POST /api/clients/:id/onboarding-links`). The link is shown once; copy it and send it.

What the client sees is a no-login page that asks for the intake checklist's client block:
company identity and business address, contacts, the updates inbox and the senders allowed to
email jobs in, licences per state, insurance and bond with expiry dates, the authorized signer,
the standard AC disconnect, where it works, and the billing contact. It can upload certificates
(PDF, PNG or JPEG, up to 10 MB each, eight per link). Its answers save as a draft between
visits until it presses submit. After submit the page shows a checklist of what is still
missing for a first filing, graded by the same code as `onboarding-readiness.ts`.

An optional section, **How you file in each place**, lists every permit office and utility its
service area names and lets it say, for each, the portal address or intake email it uses,
whether it has an account there (yes or no, never the login) and a recent permit or
application number as an example.

What you need to know about it:

- **Nothing the client types changes the client record.** Each answer that differs from what
  is on file becomes a proposal on the Clients screen. A signed-in person accepts it (as sent
  or edited) or rejects it, one by one or with *Accept all*, and each decision is audited.
  Licences and service-area places are accepted as additions only; a blank answer never blanks
  a stored value. The EIN is not asked for on this page.
- **What it says about how it files is never a destination.** Each answer shows in
  *Destinations to confirm* as a proposal marked **Client-supplied**, on that client's jobs and
  service area only. One-click Confirm is refused for it: you open the authority's own page
  and record the destination through Edit, with the page and its words, as your own check.
  Where a person already verified a different destination, both are shown under *The client
  says otherwise* and the verified record is untouched (§3.5).
- **Portal passwords never pass through it.** For each portal the client names, the page hands
  off to the one-time login link of §5. A body carrying anything shaped like a password or a
  security answer is refused.
- **The link expires** (14 days by default, 60 at most), can be revoked, and there is one open
  link per client: creating a new one revokes the old one and carries the draft and uploads
  over, so a lost link costs the client nothing. Only a hash of the token is stored.
- **It needs a public `PUBLIC_BASE_URL`.** When you create the link the Clients screen says so
  if the address is one a client cannot open (§4.3). Do not send that link: fix the setting,
  then create the link again.
- **Uploaded certificates are files for staff to open** from the Clients screen. Nothing reads
  them, fills a portal from them or sends them to a model, and an AHJ's certificate upload is
  still a person's step.
- **Not on the page, still yours to enter:** Oregon's named licence fields (the CCB number and
  its expiry, the company electrical licence, the supervising electrician and their licence,
  the metro/city licence), `docketNumber`, the EIN, and the billing mode and fee fields. An
  Oregon job's staging gate reads the CCB field itself, so for an Oregon client type the CCB
  number into the Clients form even when the client listed an Oregon licence on its setup page.

The intake file and `onboard-company.ts` (§3.2, §3.3) remain the scripted route, and the only
one that loads portal credentials in bulk. The two can be mixed: the script never removes a
licence or a place already on file.

### 3.5 Service area, and confirming where each authority takes its filings

**Record where the client works** on the Clients screen under *Service area* (or in the intake
file's `client.serviceArea`, or by accepting what the client sent on its setup link): each
state, city or county, and utility. It is client data, it decides nothing about any job, and
it is never sent to a model. Its one purpose is that **Destinations to confirm** (the button
on the dashboard, `GET /api/filing-destinations`) and the coverage report then list every
authority in the area that no open job names yet, marked "service area", so the destination
can be confirmed before the first job.

**Why this is an onboarding step now: nothing files automatically to a destination no named
person confirmed.** Approve & auto-submit refuses a run whose track has no person-verified
filing destination, and refuses a recipe that drives any host other than that destination. A
destination read from a page, imported, shipped with the product or found by research does not
count, however official the page. So every authority needs one Confirm (or Edit) by a named
person before a filing there can be automatic. Staging to the review screen for a person to
submit is not affected.

For each row in the queue:

- **Confirm** is offered when the proposed address was read on the authority's own official
  page, and the row shows the page link and its words. Open the page, check it, press Confirm.
- **Edit** is for everything else: a cited page that is not the authority's official site, a
  seeded address with no page words, and anything a client supplied. You state the address,
  the page you read and its words as your own check.
- **Reject** removes a wrong proposal so it is not offered again.

The destination can be a portal address, an email address, or "filed inside the city's
permit". Every one of them passes the same refusals before it is written: a permit track never
takes a utility portal and the reverse, an information page is never a portal, and a filing
email must be one address and not a personal mailbox. What Confirm writes is the ordinary
person-verified record, with the person's name and the time.

Do this on D1-3 for the client's whole service area. A destination left unconfirmed does not
stop a job being staged; it means every filing there ends with a person's click on the portal
until someone confirms it.

---

## 4. Verifying — the config check, then the customer's coverage report

**Two different documents, and they are not interchangeable.**
`onboarding-readiness.ts` is for you: is our own configuration complete enough to attempt a
filing. `coverage-report.ts` is for them: which of THEIR jurisdictions we can actually file in
today. Run the readiness check first — a NOT-READY client makes the coverage report answer a
question nobody asked — then produce the coverage report as the D2-3 deliverable.

### 4.1 `onboarding-readiness.ts` — the config check

```
npx tsx scripts/onboarding-readiness.ts
npx tsx scripts/onboarding-readiness.ts --client=<clientId>
```

**This one has no usage-only mode — do not run it bare to see its flags.** Unlike
`onboard-company.ts`, running it with no arguments opens the default database (`AUTOPILOT_DB_PATH`,
else `backend/data/autopilot.sqlite` — i.e. the LIVE one) and performs the full check against
whichever single client it finds, naming them and exiting 1 if there is more than one. Read the
flags at the top of `scripts/onboarding-readiness.ts`, and pass `--db <copy>` if you want to
poke at it without opening the live file. It writes nothing of its own — no INSERT, UPDATE or DELETE
anywhere in it, and it never repairs what it finds. It is **not** true that a run leaves the
database untouched, though, and the difference is worth knowing before you quote it to anyone:
`openDatabase()` re-seeds the baseline knowledge base unversioned on every open
(`backend/src/db.ts:1005`), which bumps `permit_utility_knowledge.updated_at` on a few hundred
rows. Measured: 385 rows' timestamps moved, no content and no row count changed. Every process
that opens this database does that, the backend server included, so the live file's mtime and
checksum prove nothing either way. Pass `--db <copy>` if the timestamps matter. It checks the
things that block a first filing,
and prints a verdict.

What it is checking, and what a failure means:

| Check | If it fails |
|---|---|
| The client row exists and sits in the right org | Provisioning landed in the wrong tenant — escalate, do not patch |
| Per state in scope (the jurisdictions you passed, the client's jobs, or its service area): a contractor licence for the permit slot, the building and electrical slots, and an electrical contractor licence for interconnection | A missing contractor or interconnection licence FAILS; a missing building or electrical one warns. An Oregon job will 409 `needsCcb` without the CCB; elsewhere the slot files blank. Labels and types only are printed, never a number. Go back to §1 |
| Standard disconnect make and model are set | The utility application has two required fields with nothing to put in them. §1 |
| Licence/business block is complete | Blank portal fields → rejected filing. Go back to §1 |
| At least one portal credential attached, each reporting `set` | The company has not sent logins yet, or the encryption key was missing when they were stored. §5 |
| `SESSION_ENCRYPTION_KEY` is set (reported as `set`/`missing`, never its value) | Nothing can decrypt a login. §3.1 |
| Each credential's stored portal URL is a real entry URL with its jurisdiction path segment | The credential will never be found at run time. §5 |
| The jurisdictions on their first projects have a recipe or a known portal URL | Not a blocker — it means a learn run is needed first. §6. Read the wording: it separates `complete` (replays) from `draft only (status "needs_rerecord")` (does NOT replay — the next filing re-learns), and it FAILS the jurisdiction when there is neither a recipe nor a portal URL: a stage there stops with nothing to drive until a person records the portal |

Two things to know about its output. It also flags credentials the portal has refused
(`STALE`) — that is operator work, not a bot defect, and it is a warning rather than a blocker.
But **its printed remedy for a stale credential is wrong**: it tells you to clear the flag with
`npm run learn:benchmark -- --host <host>`, which will silently skip that host. Use the sequence
in §6 (`--include-stale`, and a successful login is what clears it).

**How to read the verdict.** A READY verdict means the configuration is complete: nothing in
our own data will block a first filing. It does **not** mean any portal works. Readiness is a
config check, not a portal test. The only thing that proves a portal is a learn run against
the real URL (§6) or a live filing. Treat READY as "cleared to attempt", not "cleared to
promise".

A NOT-READY verdict names the failing check. Every one of them maps to a section above; fix
it and re-run. Do not proceed with a NOT-READY client on the theory that the first filing
will reveal the problem — it will, at the customer's expense.

The client-data half of this check (company name, licences per state, the disconnect) is the
same code that draws the checklist a client sees after submitting its Company setup page
(`backend/src/onboardingReadiness.ts`), so the two cannot disagree about what is missing.

### 4.2 `coverage-report.ts` — the D2-3 deliverable, in the guide's own words

```
npm run coverage:report -- --client <clientId> --jurisdictions "OR|City of Coos Bay|Pacific Power, IL||Ameren Illinois"
npm run coverage:report -- --client <clientId> --json > ~/reports/cascade-ridge-coverage.json
npx tsx scripts/coverage-report.ts --client <clientId> --db backend/data/copy.sqlite
```

This is the document the guide promises on day 2-3: **"Which of your jurisdictions are ready
now, which need a supervised first run, and which can't be filed yet."** Transcribe the
jurisdictions from the intake packet's own `jurisdictions` array into `--jurisdictions`
("STATE|AHJ|UTILITY", any part may be empty; add a fourth part — `electrical`, `structural` or
`combo` — to ask about one permit discipline). Omit the flag and it uses the distinct
state/AHJ/utility triples of the client's existing projects instead.

**Every jurisdiction produces up to TWO rows**, because coverage is per track and a company is
routinely ready on one and blocked on the other. Permit and NEM resolve different recipes,
different portal URLs and different logins, and the report never crosses them.

What the three buckets mean, exactly — the line between them is the whole value of the
document, so do not paraphrase it to a customer:

| Bucket | What it takes to be in it |
|---|---|
| **READY NOW** | a `complete` recipe that production's own lookup resolves for that track, AND a stored login **this portal has accepted for this customer** |
| **SUPERVISED FIRST RUN** | everything is there except proof. Either no complete recipe (the first filing is a learn run), or a complete recipe whose login this customer has never had accepted — a recipe recorded against OUR account is evidence about the portal, not about their access to it |
| **CANNOT FILE YET** | no portal URL, no login, a login with no stored password, a login the portal has **refused**, or a portal that emails a code at login with **nobody named to relay it** |

Three things to know before you send it:

- **READY NOW is not "unattended".** A filing there still stops at the portal's own review
  screen for a person to check and submit, and the report says so on every row. A portal that
  challenges a code at login can reach READY NOW once an inbox is named, and the row then
  carries "a person has to relay one every session". Do not let that line be edited out.
- **It reports what it can prove, and refuses to guess.** It opens no network connection, so a
  jurisdiction production would research on first use reports as "no portal URL known" here —
  which reads as CANNOT FILE YET. That is the safe direction: it says we have not confirmed a
  portal, rather than promising one no human has opened. It also deliberately does not count
  an AHJ *information* page as a portal URL, though production will fall back to one.
- **`--json` prints the report and nothing else**, so `> file.json` is safe to pipe. Nothing
  in either output is a secret: a login appears as its username reference and set/missing.

The report is read-only in its own code and exits 0 even when every row is blocked — the
blocked rows ARE the deliverable. Note the same caveat that applies to the readiness script:
opening the database re-seeds the baseline knowledge base, which bumps a few hundred
`permit_utility_knowledge.updated_at` timestamps (no content, no row count). Pass
`--db <copy>` if that matters.

Jurisdictions that only the client's service area names (no job yet) are included and marked
"service area" (§3.5).

### 4.3 The go-live check — is the SERVER ready for a real client

The readiness check asks whether the client's data is complete. This one asks whether the
install is: which switches and settings are on, which are missing, and what each means, one
plain line each.

```
npm run golive:check
npm run golive:check -- --json
npm run golive:check -- --org <id>
```

The same report is the **Go-live check** button on the dashboard (admins only,
`GET /api/go-live`). It is read-only: the command opens the database with a read-only
connection, and it never prints a setting's value, only set / not set. It exits 1 when any
line is red. Each line is ok, off (deliberately off and safe), a warning, or red (a blocker
for going live).

The lines that matter on a client's first day:

| Line | What to read it for |
|---|---|
| **Client link address** | `PUBLIC_BASE_URL`. Red when it is unset or an address a client cannot open (localhost, a private address, a name that only resolves inside a network). Until it is fixed, every client email carrying a link is **held as a draft** instead of being sent: the status update, the request links, the installer handoff and the invoice email. That is the client-link guard, and it also scans the message body for such a link whatever the setting says |
| **Emails held for a dead link** / **Unsent client emails** | how many messages the guard or a missing mail server kept back. Each is a CRM draft carrying the reason; send it by hand once the setting is fixed |
| **Client emails** | `CLIENT_NOTIFICATIONS`. Off silences every client email except for the client ids on `CLIENT_NOTIFICATIONS_ALLOW_CLIENTS` |
| **Outgoing mail server** | not set up means every client email is only saved as a draft |
| **Automatic portal submit** / **Automatic filing email** | `PORTAL_ALLOW_FINAL_SUBMIT` and `FILING_EMAIL_ALLOW_SEND`. Off is the safe default for a new install: every filing then ends with a person's click or a person's send (§7) |
| **Filing destinations to confirm** | how many authorities are waiting on a person in Destinations to confirm, and how many of those are only in a service area (§3.5) |
| **Saved-login encryption key**, **Sign-in**, **Who can reach the server** | the same preconditions as §3.1, plus whether the server is reachable by anyone but staff |
| **Automatic backups** / **Off-machine copy** | whether a backup exists and how old it is |

Run it before the first Company setup link or status email goes to a real client, and again
after any change to `.env`. A red line is a reason not to send that client anything yet.

---

## 5. Portal credential intake — how the company hands us logins

The company's portal logins are the most sensitive thing we hold. They are the credentials to
a government system, filing under that company's licence. Treat them accordingly.

### What we actually do

1. **Send them OUR one-time secure link, or take the logins by phone. Never email, text or
   chat.** The link is the guide's own promise and it now exists in the product:

   ```
   curl -X POST localhost:4173/api/clients/<clientId>/credential-requests \
     -H 'content-type: application/json' \
     -d '{"portals":[{"portalType":"OR · Accela","portalUrl":"https://aca-oregon.accela.com/oregon/"}]}'
   → { "token":"…", "expiresAt":"…", "url":"https://<PUBLIC_BASE_URL>/credentials?token=…" }
   ```

   Send them the `url`. They open it once, type the credentials, and the password goes
   straight into the AES-256-GCM envelope through the ordinary writer. The properties that
   make it safe to send are worth knowing, because they are also what you tell their security
   reviewer: it is **write-only** (the page never echoes anything submitted, so a forwarded
   link leaks nothing), **single-use** (spent on the first successful submission), **expiring**
   (72 hours by default, `ttlHours` to change it), and **constrained** (a token-holder can
   only supply logins for the portals the request named — no adding a portal, no repointing a
   URL). Unknown, spent and expired tokens all return the same message, so a prober learns
   nothing. `PUBLIC_BASE_URL` must be set to a public address or the `url` comes back with an
   empty host (§4.3).

   A client working through its Company setup page (§3.4) reaches the same one-time page from
   there: for each portal it names, the setup page mints one of these requests (at most five
   hand-offs per setup link, ten portals each). The password still goes only through this
   page and its encryption, never through the setup page.

   The same form collects the two per-portal answers the intake packet asks for and that
   nothing else captures at the right grain: **"Emailed code at login? Which inbox?"** and
   **who pays that portal's fees**. Ask them to fill those in while they are there — the
   coverage report reads both.

   If a customer has already emailed you a password, tell them so, get the password rotated on
   the portal, and take the new one properly.
2. **Never paste a password into Slack, email, a ticket, a commit, or a shell command that
   lands in your history.** If you have, the password is burned — rotate it.
3. **Type them into your intake file — the copy you made OUTSIDE the repo (§3.2)** — and load
   them with `scripts/onboard-company.ts` (or, for a bulk load,
   `npm run import:portal-processes -- <file.xlsx>`). They go straight into an AES-256-GCM
   encrypted envelope keyed by `SESSION_ENCRYPTION_KEY`. The API never returns a password; the
   only thing anyone can read back is `hasSecret` and a username reference.
4. **Delete every plaintext copy afterwards.** The filled intake file, the one-time link, the
   note you took on the phone, the workbook. The encrypted database column is the only place a
   portal password should live. `.gitignore` stops a filled intake at the repo root, under
   `docs/`, or in any `intake/` folder from being committed — but an ignored file is an
   invisible one, so it will sit there with live passwords in it until you delete it. Deleting
   it is the step; the ignore rule only stops the worse outcome.

### Three specific traps

**Security-question answers must go through the script, NOT the REST API.** The
`POST /api/clients/:id/portal-credentials` route silently DISCARDS a `securityAnswers` field —
the request validator strips unknown keys, so there is no error and no warning, and the answers
never reach storage. Portals that challenge security questions on a new device then stall for a
human even though the customer gave us the answers. Use the script or the workbook import;
those call the storage function directly and the answers ride inside the encrypted envelope.

**Never put a secret in the `notes` field.** That column is plaintext AND it is fed to the LLM
as research context. Operational hints only ("account is shared with the electrician",
"login emails a one-time code"). Security answers belong in `securityAnswers`, passwords
nowhere but the encrypted envelope.

**The portal URL is the load-bearing field, not the portal type.** At run time we find a
credential by matching the target URL's hostname AND its first path segment. Accela serves
dozens of cities from one host and distinguishes them only by `/sandiego`, `/SACRAMENTO`,
`/lascruces`. So store the real login/entry URL **including the jurisdiction path segment**. A
host match with the wrong segment is refused outright rather than guessed at — which is
correct, because the alternative is typing one city's password into another city's login form
and locking the account. Getting the portal type label wrong costs almost nothing; getting the
URL wrong means the credential is never found at all.

### Where the credential material actually lives — including the part that is NOT encrypted

Their security review will ask this, and the honest answer has two halves. Give them both;
finding the second half themselves is much worse.

| What | Where | Protected by |
|---|---|---|
| Portal username, password, security answers | `portal_credentials.encrypted_secret` in the SQLite DB | AES-256-GCM under `SESSION_ENCRYPTION_KEY`. The API never returns a password — only `hasSecret` and a username reference |
| `portal_credentials.notes` | same table, **plaintext column** | nothing. It is also fed to the LLM as research context. Operational hints only |
| **Live portal SESSION state — cookies, `Login Data`, local storage** | `portal-profiles/<clientId>/<portalType>/` on the server's disk (`repository.ts:5516-5518`; base overridable with `PORTAL_PROFILES_DIR`) | **nothing. It is a plain Chrome profile directory.** Gitignored, so it never reaches the repo, but it is NOT encrypted and it is outside `SESSION_ENCRYPTION_KEY` entirely |
| Mirrored copies of that session state | `backups/portal-profiles/<clientId>/…`, written beside the DB snapshots by **every** `runBackup` (`backend/src/backup.ts`) | nothing. The backup deliberately mirrors `Cookies`, `Login Data`, `Local/Session Storage`, `Preferences` and friends, because a DB-only restore came back with every portal session dead. Note this contradicts `docs/SCALE_DEPLOYMENT.md` §1.5, which predates the mirror — the code is the authority |
| Raw screenshots and Playwright traces of their portal | `data/learn-runs/<runId>/` | nothing (gitignored). JSON artifacts mask sensitive values; **the PNGs and the trace are raw renders and can show customer and homeowner data.** Self-pruned to the newest `AUTOLEARN_RUN_KEEP` (default 20) run folders — and only when a new run happens |

What this means in plain terms: **those profile directories ARE the portal logins.** Anyone with
filesystem access to the server, or to a backup archive, holds a live session to their
government portal account without needing the password or the encryption key. That is the
sentence to put in front of whoever owns server access. Nothing in the product protects those
directories, so on a real deployment the protection has to come from the host — encrypted
storage and restricted filesystem permissions on `PORTAL_PROFILES_DIR` and on `backups/`. That
is a deployment decision nobody has recorded yet; do not tell a customer it is done without
checking the box it runs on. And do not describe our credential handling as "encrypted at rest"
full stop — the passwords are; the sessions are not.

### Offboarding a company

The guide's leaving clause: *"If you ever leave, change your portal passwords; we then remove
your credentials, sessions, projects and documents from our live systems."* That sentence is
now executed by one command, and the order in it is load-bearing.

1. **They rotate every portal password first, on their side.** This is the only step that
   revokes access with certainty, and it does not depend on our cleanup being complete. We
   cannot invalidate a session we no longer hold: once the files are gone we cannot log in to
   end anything, and a session cookie that leaked before the purge outlives it. Their password
   change closes the door; our run stops us holding the key.
2. **Dry run.** `npx tsx scripts/offboard-company.ts <clientId>` — the DEFAULT posture is dry
   run, so this writes nothing, not even the audit row. It prints the inventory first: N
   credentials, N projects, N documents, N customers, N communications, N session directories.
   **If those numbers are not the company you meant, stop.** `--list` prints client ids and
   names so the id can be copied rather than typed.
3. **The purge.** `npx tsx scripts/offboard-company.ts <clientId> --confirm <clientId>`, plus
   `--actor=<your email>` so the audit row names a human. `--confirm` takes the client id and
   **must match** — a mistyped id is refused outright rather than falling back to a dry run,
   because the id you fat-finger may be another live customer's. It also refuses without a real
   `SESSION_ENCRYPTION_KEY`: half of what it destroys is ciphertext keyed by that value, and a
   process that cannot read it is a process pointed at the wrong environment.

   What it removes: `portal_credentials` (the encrypted passwords — the headline promise),
   every project through the ordinary `deleteProject` cascade (QC results, submissions,
   corrections, audit rows, `historical_failure_examples`, and the document files unlinked
   from disk), `customers`, `communications` (deleted FIRST, because both cascades only unlink
   them and a row can otherwise survive both, orphaned, still carrying the homeowner's name),
   `email_tracking_sources` (which hold their own encrypted IMAP password),
   `client_portal_identities`, `portal_profiles`, the one-time credential requests, the Company
   setup links with the client's proposed answers and uploaded certificates, what the client
   said about how it files (`client_filing_statements`), the `clients` row, and the on-disk
   session directory `portal-profiles/<clientId>/`. It writes a `client.offboarded` audit row with a
   null project id, so the record outlives every project it names.

   **Read the session-directory result rather than assuming it.** Directories it failed to
   remove are reported, not swallowed — a running Chrome holds a profile open on Windows, and
   "we removed your sessions" that silently did not is this exact bug again.
4. **Then the three things it deliberately does not touch**, each still a person on the server:
   - `backups/portal-profiles/<clientId>/` — the backup mirror of the session state. The live
     directory is gone; this copy is not, and it is just as much a live login. `rm -rf` it.
   - `backups/documents/` — the document mirror keeps its copy on purpose, so plan sets and
     stamped letters survive there.
   - `data/learn-runs/` — raw screenshots of their portal account. Retention is "newest 20
     folders, pruned when a new run happens", so once they leave nothing prunes them at all.
5. **Leave the pooled knowledge alone, and say so at intake rather than at exit.** Portal
   recipes, AHJ and utility knowledge, code profiles, form templates and CEC equipment rows
   carry **no `org_id` and no `client_id`** — shared across every tenant on purpose (CLAUDE.md,
   "Shared knowledge is shared ON PURPOSE") — and they hold jurisdiction facts, not customer
   data. **They stay.** What DOES carry their data, `historical_failure_examples`, goes with
   their projects. The append-only draft ledger stays too: it holds no secret, and erasing it
   erases the list of drafts they still have to cancel on their own portal accounts.

`DELETE /api/clients/:id` still refuses with a 409 while any project points at the client, and
that is deliberate rather than an oversight: the dashboard path stays hard so a misclick cannot
destroy a company's filings, while the deliberate path is flagged, confirmed and audited
precisely because it can.

Still true and worth stating rather than hiding: nothing removes their data from historical
backup SNAPSHOTS short of deleting the snapshots, and step 4 has no API surface at all. If a
customer's contract requires provable deletion, that is engineering work to quote, not a
checkbox to promise.

### What MFA on their portal account means for us

Say this to the customer explicitly, because it changes what they have to staff:

- **If the portal challenges MFA or a CAPTCHA, the run stops and waits.** The project lands in
  `paused_for_human` with a message naming the challenge. Nothing was staged.
- **A human completes the challenge in the open browser, then we re-stage.** That human has to
  be at the machine running the browser. On an operator desktop (`PORTAL_HEADLESS=false`) the
  browser is visible and this works. On a headless server there is no browser to sit at — the
  paused filing has to be finished from a desktop or a supervised remote session.
- **Automation never solves it.** Not with a flag, not with a service, not "for now". Portals
  that email a one-time code at every login are flagged as human-capture-at-login and will need
  a person present for each session.
- **Stored security answers help; a one-time code does not.** Answers to fixed security
  questions we can store and replay. A code sent to their phone or inbox, we cannot.
- Ask whether they can put us on an account whose MFA is not tied to one person's phone. Some
  portals allow a service account; many do not, and that is a real constraint on how fast we
  can file for them.
- **Get the answer written down, per portal, not just discussed.** The intake asks "Emailed
  code at login? Which inbox?" for each portal account, and the answer has a home now:
  `mfaRequired` and `mfaCodeDestination` on that credential. A destination is who to ask for
  the code — a shared inbox we can read, or the person who relays it — and it is not a secret,
  which is exactly why it belongs in a field rather than in somebody's memory. A paused run can
  then name where the code will arrive instead of only saying it stopped, and
  **`coverage-report.ts` puts any MFA portal with no destination in CANNOT FILE YET** (§4.2).
  That is the correct answer: a portal nobody can get a code for is not a portal we can file
  through, however good the recipe is.

---

## 6. Jurisdiction warm-up — the first time we see an AHJ or utility

### Most jurisdictions are already partly known

Portal knowledge is pooled on purpose and shared across every customer. A new company inherits,
on day one: every portal recipe we have recorded, every AHJ and utility profile
(portal URL, required documents, known quirks), every mapped AHJ form, every verified code
profile, and the CEC equipment name normalisation. A quirk learned once for one installer helps
every installer afterwards. This is the core asset of the product; it is why the second customer
in a state is much cheaper to onboard than the first.

So the warm-up question is never "does this company work" — it is "have we ever touched THIS
jurisdiction's portal".

### What happens the first time we have not

There are two outcomes:

- **We have a recipe or a known portal URL for it.** The run opens a real browser, replays or
  drives the portal, and stages for review. Normal.
- **We have neither.** The stage stops with a message naming the reason: no portal URL is
  known (and research could not confirm one), a recording learned elsewhere on that portal was
  not reused for this agency, or the authority's own page says this permit is filed some other
  way (by email, in person, by mail, with another permit). Nothing is opened and the project is
  not marked staged.

The simulated portal that older versions of this runbook warned about runs only when
`MOCK_PORTAL=1` is set on the server, which is for the smoke test and rehearsals. On a live
install that switch must be off; the go-live check shows it red when it is on (§4.3). It is
still worth confirming a first stage in a new jurisdiction by its artifacts — a learn-run
bundle under `data/learn-runs/`, a review screenshot, a recipe row. `npm run ops` lists the
recent portal recipes and the latest run artifacts.

### A recipe row is NOT readiness — read its status

This is the trap: you check for a recipe, you find one, and you
conclude the jurisdiction is covered. Most recipe rows do not replay. The counts as of
2026-09-09 (not re-counted for the 2026-11-11 revision; `npm run ops` prints today's):

| `portal_recipes.status` | Count (2026-09-09) | What it does at run time |
|---|---|---|
| `complete` | **6** | replays. This is the only status that reuses recorded steps |
| `recording` | 15 | does not replay — a learn was in progress or died mid-walk |
| `needs_rerecord` | **55** | does not replay. The next stage RE-LEARNS from scratch |

Only `complete` recipes are selected for replay (`findCompleteRecipeForProject`). **The largest
bucket, `needs_rerecord`, behaves exactly like "no recipe at all" at run time** — it means a
learn failed, or did not stage cleanly, or a replay step broke against a changed portal and the
row was invalidated. So:

- **A recipe row for the jurisdiction proves nothing.** Read the status. `npm run ops` prints
  it per row.
- A `needs_rerecord` row means the next filing there triggers a live LLM-driven learn — minutes,
  cost, a real browser, and a fresh draft application in the customer's account. It is not the
  nothing-to-drive case: a recipe row of any status carries its own `portal_url`, so there is
  somewhere to go. Nothing to drive means **no recipe row at all and no portal URL in the
  knowledge base**, which is exactly the combination the readiness script fails on.
- Six complete recipes against 68 portal hosts is the honest shape of coverage. Do not quote a
  recipe count to a customer as if it were a supported-jurisdiction count.

### The learn run

To teach the system a portal, point it at the real entry URL for a real project. This is the
operator-facing path:

```
curl -X POST localhost:4173/api/projects/<projectId>/auto-learn \
  -H 'content-type: application/json' \
  -d '{"portalUrl":"https://aca-oregon.accela.com/oregon/","scope":"ahj"}'
→ 202 { "jobId": "..." }
```

`scope` is `ahj` for a permit portal or `utility` for a NEM/interconnection portal — **never
cross them.** A permit filing must never be pointed at a utility portal (PowerClerk) or the
reverse; the code guards this, and so should you. For an Accela-style portal where one address
falls under both a city and a county authority, add
`"permitType":"structural"` or `"electrical"` to say which discipline this pass files.

It runs as a background job because a live LLM-driven browser pass takes minutes. Poll
`/api/jobs/<jobId>`; the verdict lands in `job.result`. Progress streams over SSE.

**Before you fire one: this writes to the customer's real portal account.** A learn walks the
application to the review screen, which on most portals means the portal has created a draft
record — real, numbered, visible to their staff, and never cleaned up by us (§2). It is also a
live session on that account, so nothing else may touch that account while it runs (see the
concurrency rule below; the lease is in-process only and will not protect you across two
terminals). Tell the customer a learn is happening on their account, and agree who cancels the
draft afterwards.

**What to expect.** On the one portal we have measured repeatedly (Ameren Illinois, PowerClerk
NEM): 8 pages, 63-70 field fills, 79 recorded steps, **about 11 minutes per attempt**. A
shallower permit portal is faster; a deep one with uploads is slower. A learn that fails or
pauses does NOT retry on a timer, by design — you read the verdict and decide.

**The result and what it means:**

| `status` in the verdict | Meaning |
|---|---|
| `trusted` | learned, verified, and (with `--self-test`) replayed. The recipe will be reused for future projects in this jurisdiction |
| `paused_for_human` with `pauseReason` `mfa_captcha` | a challenge stopped it. A human clears it in the browser, then re-run. A partial draft recipe was saved |
| a recorded but incomplete draft | it walked but did not reach review. Read the bundle (§8) |

`finalSubmitRecorded: true` in the verdict means the final submit button was **recorded and not
clicked**. That is the correct, expected outcome.

### Measuring a portal deliberately

`npm run learn:benchmark` drives portals we hold credentials for and writes a scorecard. It is
the tool for answering "does this customer's portal work" before promising anything:

```
npm run learn:benchmark -- --host amerenillinoisinterconnect
npm run learn:benchmark -- --host <host> --repeat 3 --self-test
npm run learn:benchmark -- --limit 6 --portal-timeout 420
```

Read the warnings before you run it:

- **It drives LIVE government portals** with real stored credentials, and it logs in under the
  customer's licence.
- **It leaves real draft applications behind in the customer's portal account.** The benchmark
  deletes the throwaway project it created **in OUR database** — that is a `projects` row, and
  nothing more. The draft the PORTAL minted while the run walked the application stays in the
  customer's account, visible to their staff and on some portals to the reviewing authority, and
  no code of ours removes it (§2, and the Miami note in `docs/HANDOFF.md`). With `--self-test` a single attempt
  can mint two, so `--repeat 3 --self-test` can leave six. **Warn the customer before you sweep
  their portals, and agree who cancels the drafts.**
- **Never run two jobs against the same portal account at once. Ever — not two benchmarks, not
  a benchmark and a live filing, not two learns.** The rule is simple because the enforcement is
  not: a learn takes a lease keyed on the recipe, but it is an **in-process** lease
  (`activeLearnKeys`, `backend/src/autoLearn.ts`), so it separates nothing between two terminals
  or two servers. Most portals allow one session per account, so the second run evicts the first
  and both results read as portal failures. This has already happened and produced a false 67%
  reliability figure that was believed for a while. Serialise by hand: one sweep at a time, and
  no filings for that client while it runs.
- **It refuses to retry a login the portal already rejected**, so real accounts do not get
  locked out — and that refusal is stickier than it looks. `--host <host>` alone will NOT get a
  stale host measured and will NOT clear the flag: the stale filter is applied AFTER the host
  filter, so the host you named is simply skipped and you get an empty sweep. **Two tools print
  exactly this wrong advice — the benchmark's own closing "CREDENTIALS NEEDING A HUMAN" line and
  the remedy line in `scripts/onboarding-readiness.ts`. Both omit `--include-stale`. Ignore
  them and use the sequence below** (and if you fix either script, fix this bullet too).
  `scripts/coverage-report.ts` prints the correct sequence on every refused-login row, so when
  two of our own tools disagree, that is the one to believe. What actually works:
  1. Get a working credential from the customer and store it (§5). Storing it does **not** clear
     the flag — nothing resets `last_login_failed_at`.
  2. Re-run with the flag that overrides the skip:
     `npm run learn:benchmark -- --host <host> --include-stale`.
  3. The flag clears **only when a login actually succeeds** — `recordLoginOutcome` writes
     `last_login_ok_at`, and `stale` is just "failed more recently than it succeeded". So the
     successful run is the thing that clears it, not the edit and not the flag.
  A harness abort (a killed run, a dead browser) is deliberately NOT recorded as a refusal —
  that mistake once retired six working credentials from every later sweep.
- `--repeat N` is what turns a single attempt into a rate. Without it, one row is one attempt.
- `--self-test` replays the freshly learned recipe in a clean session and refuses to call it
  trusted unless it reproduces. It roughly doubles the time, and it re-drives the live portal —
  which is where the second draft application comes from. It is also the only thing that answers
  "can the bot re-run what it just learned" — the first time it was run by hand, the answer
  was no.
- **The per-portal budget is 8 minutes by default** (`--portal-timeout`, in seconds), and a
  portal that runs out of budget is scored on what it reached rather than failed. So a deep
  application can TRUNCATE and report a partial walk that looks like an engine limit. Ameren
  alone takes ~11 minutes per attempt, which is over the default: raise `--portal-timeout` when
  you are measuring a deep portal, and read the page trace before believing a low score. (An
  operator-triggered learn over the API has no budget at all unless one is passed — the cap is a
  benchmark thing.)
- **Check free disk before trusting a sweep.** A low-disk machine once produced eleven
  consecutive false `unreachable` verdicts in eight seconds.

### Reuse

Once a recipe is complete, later projects in that jurisdiction replay it instead of learning
again — for this customer and for every other. Final submit stays manual on a replay unless a
named person approves that exact run with Approve & auto-submit, and every other condition in
§7 holds: the track's filing destination is person-verified and the recipe drives that
destination, the server has `PORTAL_ALLOW_FINAL_SUBMIT=1`, and the recipe is complete and was
recorded through the submit. The approval is a separate, per-run decision. The destination
Confirm is the part that belongs to onboarding (§3.5). There is no per-recipe "trusted" arm.

---

## 7. The first real filing, end to end

Do the first one yourself, watching, with the customer told it is a supervised first run.

For a NEM filing, the click-by-click version (Approve & auto-submit, the hand-over fallback, PSE,
tracking) is `docs/NEM_OPERATOR_RUNBOOK.md`.

1. **Intake.** Create the project from the parsed plan set, then bind the client:
   `POST /api/projects/:id/client {"clientId":"..."}`. Until a client is bound, staging refuses
   with `needsClient`. If you need the installer to supply the job valuation or the homeowner's
   contact details, `POST /api/projects/:id/intake-request` returns a shareable link you can
   paste into an email; they fill it in and the project updates.
2. **Parse.** The plan set becomes structured fields — equipment, counts, addresses, electrical
   values. Check the parsed equipment against the plan set on this first project. Certified
   equipment names differ from plan-set names, and a wrong inverter model is a rejected filing.
3. **QC.** Automatic checks against the AHJ's adopted codes. Failures surface as QC results and
   human review items.
4. **Reviewer gate.** `GET /api/projects/:id/reviewer-report` lists findings; any finding at
   `blocker` severity stops the run. This gate exists to catch the design problem before a
   government reviewer catches it. Clear blockers before staging, not after.
5. **Stage.** Creating the project normally enqueues this automatically (Segment A:
   QC → build → reviewer gate → stage). To drive it by hand:
   `POST /api/projects/:id/prepare-submission {"track":"nem"}` (or `building`, `electrical`,
   `combo`, `permit`, `mpu`). It refuses, each as a 409 naming the reason, if: required
   documents are missing (`missingDocuments`), the permit path is unconfirmed for a non-NEM
   track (`permitPathUnknown`), no client is bound (`needsClient`), an Oregon job's client has
   no CCB number (`needsCcb`; in other states a missing licence is a warning on the submit
   gate and a blank slot, §1), or a required per-portal project field is blank
   (`missingPortalFields`). Each of those is a fixable data problem, not a failure.
6. **Staged.** The project lands in `awaiting_human_submit`. The message is "Portal staged —
   verify and submit manually." **Before telling the customer, confirm it by its artifacts**: a
   review screenshot and a learn or portal run artifact exist. For a brand-new jurisdiction
   with no portal on file the stage does not get this far; it stops and names why (§6).
7. **A named person files.** Two ways, and the first is the default:
   - **A person submits on the portal.** They open the staged application, read the filled
     fields, and press submit. Fees are paid there, by them.
   - **Approve & auto-submit** (on the rail or the track card, the same action). The button
     opens the **approval sheet**: the applicant, owner and service address, the utility or
     issuing agency, the account and meter numbers (last four only), system size and
     equipment, the submitting company and signer, where each value came from, and every
     disagreement between sources first. It also shows how and where this run files (the
     portal host or the email recipient), every attachment, and this filing's open review
     items. A measured reviewer finding and an unverified form mapping each need a tick before
     Approve enables. The approval is recorded under the approver's name for exactly that one
     run, which then starts from the beginning of the application.

     The run clicks the portal's submit only when **all** of these hold, and stops at the
     review screen for a person's click when any does not:
     - the approval is for this run and has not been used;
     - the track's filing destination is person-verified (§3.5) and the recipe's entry address
       and every page it navigates to are on that destination;
     - `PORTAL_ALLOW_FINAL_SUBMIT=1` is set on the server;
     - the recipe is `complete`, was recorded for this jurisdiction (a borrowed recipe always
       stops at review) and has one flagged, final submit step in a valid shape;
     - nothing the approver acknowledged has changed since: no new or changed measured finding,
       no replaced plan set.

     It never pays a fee, and a payment control or dialog stops the run. On a staged NEM draft
     it is held: the human finishes that draft.
8. **After.** The permit monitor watches for status changes and corrections. A correction
   reopens the filing through a named form; the automation refills and a named person files
   again.

**When the authority takes the application by email.** Where a named person has recorded a
filing email address for the authority (through Destinations to confirm, or on the job itself),
that track files by email instead of on a portal. The message is **staged as a draft**: a
person downloads it, sends it and marks the track submitted. Automation sends it only under the
same approval as above plus its own switch, `FILING_EMAIL_ALLOW_SEND=1` (turning the portal
switch on never turns email on), to the person-verified address, once per filing and never
again on a retry. The approval sheet says in so many words that an email cannot be recalled.
The subject and body carry no account or meter number; those travel only inside the attached
forms. The authority's reply comes back to the filings mailbox and is filed on the job's track
like any other agency email.

**Battery jobs.** A plan set with battery storage changes four things, and they are worth
saying to a client that installs batteries:

- two more required documents on the permit side, the storage system's spec sheet (UL 9540)
  and its installation detail (location, clearances, disconnect);
- a storage review that reads the package's own facts (unit count and kWh, where it sits,
  spacing, the listing, the disconnect) against the model code and any rule of the
  jurisdiction's own. A broken rule is a warning unless the rule is the jurisdiction's,
  person-verified or read on its official page with its words, and the fact is stated on the
  plan's own sheets; a missing detail is one warning listing what is not shown;
- the interconnection track **stays on for every battery job by default**. It is dropped only
  where a named person recorded, from the utility's own page, that a given storage mode needs
  no application; a record of any other kind is shown and decides nothing;
- on an electrical permit the fee sheet adds a services/feeders line for the battery.

Whether the AHJ wants a separate fire review or storage permit is shown on the permit card
from what is on file, or as "not on file, verify". It is a step a person handles, not a track
the automation files.

### 7.1 Invoices

Billing is the Clients screen's invoices (`/api/clients/:id/invoices`). A statement for a
period carries every billable line not already on a live invoice, so creating one twice never
repeats a charge. A person creates it, a person presses send (it is emailed to
`billingContactEmail`, falling back to `businessEmail` and then `contactEmail`, through the
same client-email switch and link guard as every other client email), and a person marks it
paid when the money arrives. **Nothing here charges a card, takes a payment or pays a fee.**

The QuickBooks push is optional and off unless `QUICKBOOKS_SYNC=1`. A named person connects
one QuickBooks company, and a named person's click on an invoice creates that invoice in
QuickBooks, once. It never charges, never takes a payment and never asks QuickBooks to email
the customer; emailing from QuickBooks stays a person's click there. The only scheduled work is
a daily read of payment status. Connecting the first real QuickBooks company is the owner's
step, not an onboarding step.

Say nothing to a client about prices from this runbook. What a filing costs them is the
owner's to state.

---

## 8. Troubleshooting the first week

Start with `npm run ops` for anything vague. It prints the job queue, recent failures, every
project that cannot stage **and why**, recent portal recipes, and the latest run artifacts —
all of which used to have to be reconstructed by hand from four places while an operator was
blocked. Add `--errors` for the tail of the backend log.

| Symptom | Most likely cause | Diagnose with |
|---|---|---|
| "Can't submit yet" / the project will not stage | One of the five 409 gates in §7.5 — usually a missing document or, on an Oregon job, a blank CCB number | `npm run ops` — it names the blocker per project. Then `npx tsx scripts/onboarding-readiness.ts --client=<id>` if it is a client-data blocker |
| The run says there is no stored credential, or it sits on the login form after submitting | Either `SESSION_ENCRYPTION_KEY` changed (decrypt fails SILENTLY and returns "no credential"), or the stored portal URL's host/path segment does not match the target | `curl -s localhost:4173/health` → `config.sessionKeySet`; then `npx tsx scripts/onboarding-readiness.ts --client=<id>` for the credential and URL checks. **Do not retry the login repeatedly — that is how accounts get locked** |
| A learn or a stage failed, and the status message is not enough | Anything from a portal notice to an engine gap | The bundle at `data/learn-runs/<runId>/` — `result.json` for the verdict, `events.jsonl` for the timeline, `pNNN-before/after-*.png` for what the page actually looked like, `pNNN-plan.json` for what the planner decided. `GET /api/learn-runs` lists runs; `GET /api/learn-runs/<runId>/bundle.zip` downloads one to attach to a bug report |
| The project is stuck, message mentions a challenge | `paused_for_human`, `pauseReason: mfa_captcha`. Expected behaviour, not a bug | `npm run ops`. A human clears the challenge in the open browser on the desktop running it, then re-stage. If the run happened on a headless server there is no browser to clear — re-run it somewhere with a visible browser |
| The stage stopped with "No portal URL is known for …" or "No portal automation is available for …" | No recipe and no portal on file for that jurisdiction, so there was nothing to drive (§6) | Record the portal once, or run the learn (§6) against the real portal URL, and re-stage. If the message says the permit is filed by email, in person or by mail, that is the authority's own channel: see §7 |
| A "staged" filing with no screenshot, no recipe and no run artifact | `MOCK_PORTAL=1` is set, so the run was simulated | `npm run golive:check` shows *Simulated portal* red. Remove the switch, restart, re-stage. **Do not tell the customer it was staged** |
| Approve & auto-submit ran and stopped at the review screen | One of §7's conditions did not hold. The run's message names it: most often the track's destination is not person-verified, the server switch is off, or a review item changed after the approval | Confirm the destination in Destinations to confirm (§3.5), or submit by hand on the portal. A refused approval is spent: approve again for the next run |
| A client says a link we sent does not open, or says it never got an email | `PUBLIC_BASE_URL` is unset or not public, so the link guard held the email as a draft; or the mail server is not set up; or client emails are off | `npm run golive:check`: *Client link address*, *Emails held for a dead link*, *Outgoing mail server*, *Client emails* (§4.3) |
| A client's Company setup link says it is no longer valid | It expired (14 days by default), was revoked, or a newer link replaced it | Create a new one on the Clients screen; the draft and uploads carry over (§3.4) |
| A jurisdiction "has a recipe" but every filing re-learns from scratch | The recipe's status is `recording` or `needs_rerecord`, which do not replay — only `complete` does. 55 of our 76 rows are `needs_rerecord` | `npm run ops` prints the status per recipe row. Treat anything but `complete` as no recipe (§6) |
| A benchmark sweep returns nothing for the host you named | The credential is flagged stale, and the stale skip is applied after `--host` | Re-run with `--include-stale` once the credential is fixed; a SUCCESSFUL login is what clears the flag (§6). Do not keep re-running a refused login |
| Two runs against one portal both "failed" at or after login | Session eviction — the portal allows one session per account and the learn lease is in-process only | Nothing to fix in the engine. Re-run them ONE at a time and compare. Assume the pair of results is void, not the portal (§6) |
| A deep portal reports a partial walk that looks like an engine limit | The 8-minute default per-portal budget truncated it | Re-run that host with a larger `--portal-timeout` and read the page trace before concluding anything (§6) |
| "Which of my jurisdictions can you actually file in?" — asked at any point, not just on D2 | Nothing is wrong; this is the question the coverage report exists for | `npm run coverage:report -- --client <id>`. Re-run it rather than quoting the D2 copy: rows move on their own as logins get accepted and recipes get recorded (§4.2) |
| The coverage report says CANNOT FILE YET for a portal you know works | Usually one of three: the login was never tried (that is SUPERVISED, not CANNOT), a code-at-login portal with no `mfaCodeDestination` recorded, or a stored portal URL whose path segment does not match | Read the row's own `why` line — it names which. The report refuses to guess a portal URL, so an unconfirmed jurisdiction reads as blocked on purpose (§4.2) |

Two habits that save the week:

- **Read the last banner, not the exit code.** The test chains are `&&`-joined and the exit
  status has misreported three times. Same discipline for scripts: read the output.
- **Suspect the measurement before the portal.** Wrong verdicts in this system have come from
  the harness far more often than from the recipe — low disk, a stale credential flag, two runs
  sharing one portal account, a benchmark address in the wrong city.

---

## 9. What to tell the customer when a portal is not yet supported

Be specific and own the timeline. "Not supported yet" with no reason and no date reads as "this
product does not work". Every one of our stopping points has a named reason and a named owner.

Find the reason first (`npm run ops`, the learn bundle, or the last benchmark row), then use the
matching line:

| What is actually true | What to say | Who unblocks it |
|---|---|---|
| We hold no login for that portal | "We need an account on that portal before we can file there. We don't create portal accounts — they have to be registered by a person on the portal's own site, and several require an emailed code — so that first step is yours. We'll send you a one-time secure link to hand us the login; never email, text or chat it." | Customer |
| The portal emails a code at login and nobody is named to relay it | "That portal sends a one-time code at every login, and software never clears one — a person does, every session. Tell us which inbox the code lands in, ideally a shared one we can read, or name someone who will relay it. Until then it isn't a portal we can file through, however well we know the application." | Customer |
| The stored login is rejected | "The credentials we have for that portal are being refused — usually because the password was rotated and we were not told. We deliberately do not retry, because repeated attempts lock the account, so that portal is paused until we have a working login. Send us one the safe way and we will re-verify the same day. Standing request: tell us the day you rotate a portal password, because we cannot detect it — we find out when a filing fails." | Customer |
| The portal requires MFA or a CAPTCHA at login | "That portal challenges every new session. We can fill the whole application, but a person has to clear the challenge at the browser. That is a permanent design choice on our side — we do not solve CAPTCHA or MFA — so filings there need someone available, not just a queue." | Human, by design |
| The portal blocks automated browsers | "That portal actively blocks automation at the network level. We can't drive it, and working around a bot block is not something we will do. Those filings stay manual." | Nobody — it stays manual |
| We log in but the application form is not filling yet | "We can reach the application but not yet fill it reliably. We don't want to hand you a half-filled filing, so that jurisdiction is manual until we have driven it properly. Each of these takes a focused engineering pass; tell us your volume there and we will prioritise accordingly." | Engineering |
| We have never seen the jurisdiction | "This is a new jurisdiction for us. The first filing there needs a learn run against the live portal — roughly a quarter-hour of supervised driving, once. After that it replays, for you and for everyone. We would rather do that before your first filing than during it." | Us, before their first filing |
| A required choice is operator knowledge we do not have | "The portal asks which permit category residential rooftop solar files under in that city. We will not guess — guessing files the wrong record type, which is worse than waiting. Tell us what your team files it as, and it is a one-time answer that then applies to every filing there." | Customer's knowledge, our data |

Seven things never to say: that the fee, the CAPTCHA, MFA or a signature will be automated in
a future version; that filing is unattended (a submit is clicked only in the run a named person
approved, and only where a person confirmed the destination — §7); that we handle inspections,
completion documents or permission to operate (§2); that a jurisdiction works because a filing
showed as "staged" (check for the artifacts first); a per-portal success rate we have not
measured with `--repeat`; that teaching a portal leaves no trace in their account (it leaves
drafts they have to cancel — §2); or that their credentials are "encrypted at rest" full stop,
when their live portal sessions sit unencrypted in `portal-profiles/` (§5).

---

## Appendix — environment this runbook depends on

| Variable | Onboarding meaning |
|---|---|
| `SESSION_ENCRYPTION_KEY` | Encrypts every stored portal login. Must be a real value — the `.env.example` placeholder counts as missing. **Rotating it without `npm run rekey:credentials` destroys every stored login, silently.** |
| `AUTH_SECRET` | Set it to its OWN stable value. It defaults to falling back to `SESSION_ENCRYPTION_KEY`, which means a key rotation logs every user out. |
| `AUTOPILOT_DB_PATH` | Which database the scripts write to. Wrong value = silently provisioning into a scratch DB. |
| `PORTAL_HEADLESS` | `false` on an operator desktop, so a human can clear a challenge in the visible browser. A headless server cannot complete a paused filing at all. |
| `PORTAL_ALLOW_FINAL_SUBMIT` | Leave it unset during onboarding. It is one of the conditions on the bot clicking a portal's final submit (§7: a named person's approval of that exact run, a person-verified destination the recipe drives, a complete recipe recorded through submit, nothing changed since the approval — `mayClickFinalSubmit` / `automaticSubmitRefusals`); the operator turns it on, never a new customer. Fees, CAPTCHA and MFA are never automated. |
| `FILING_EMAIL_ALLOW_SEND` | The email door's own switch (§7). Unset, a filing email is always a draft a person sends. Turning the portal switch on does not turn this on. |
| `PUBLIC_BASE_URL` | The address every client link is built against: the Company setup link, the one-time credential link, the status page (§3.4, §5). It must be an address a client can open. Otherwise the client-link guard holds every client email that carries a link as a draft, and the go-live check shows the line red (§4.3). |
| `CLIENT_NOTIFICATIONS`, `CLIENT_NOTIFICATIONS_ALLOW_CLIENTS` | `off` silences every client email; the allow list names client ids that are still mailed while it is off. Know which state the server is in before telling a client to expect updates (§4.3). |
| `MOCK_PORTAL` | Must be unset on a live install. `1` makes portal runs simulated (§6). |
| `QUICKBOOKS_SYNC` | `1` turns the QuickBooks push on (§7.1). Anything else, including unset, means no call to QuickBooks at all. |

Scripts this runbook uses, in the order the seven days need them:

| Command | What it is for | Section |
|---|---|---|
| `npx tsx scripts/onboard-company.ts <intake.json> [--dry-run]` | D1-2 — create the client, licence block and credentials | §3 |
| Clients screen → *Create company setup link* (`POST /api/clients/:id/onboarding-links`) | D1-2 — the client fills in its own block; you accept the answers | §3.4 |
| `POST /api/clients/:id/credential-requests` | D1-2 — mint the one-time secure link for their logins | §5 |
| Dashboard → *Destinations to confirm* (`GET /api/filing-destinations`) | D1-3 — confirm where each authority in their service area takes its filings | §3.5 |
| `npm run golive:check` | before the first link or email reaches a real client, and after any `.env` change | §4.3 |
| `npx tsx scripts/onboarding-readiness.ts --client=<id>` | D2 — is OUR configuration complete | §4.1 |
| `npm run coverage:report -- --client <id>` | **D2-3 — the customer's coverage report** | §4.2 |
| `npm run fee:sheet -- --project <id>` | D0 and any day after — what a job costs, where each number came from, and who agreed to pay it | §0.5 |
| `npm run learn:benchmark -- --host <host> [--include-stale]` | D3-6 — verify each portal, one at a time | §6 |
| `npx tsx scripts/draft-ledger.ts` | any day — the drafts we left on their real portal accounts | §2 |
| `npm run ops` | any day — job queue, blockers, recipes, run artifacts | §8 |
| `npx tsx scripts/offboard-company.ts <id> [--confirm <id>]` | exit — the leaving clause, executed | §5 |

Related reading: `docs/onboarding/INTAKE_CHECKLIST.md` (what to collect),
`docs/onboarding/CAPABILITIES.md` (measured capability per platform, and where the guide's
promises are not yet met), `docs/HANDOFF.md` (current state, open issues, what to verify after
each pull), `docs/SERVER_SETUP.md` (hosting), `docs/products/README.md` (the split-out
products).
