
**Proprietary and confidential.** Copyright (c) 2026 Keelix. All rights reserved. This code is
Keelix's property and trade secret; no licence is granted without a written agreement with Keelix.
See [LICENSE](LICENSE).



## Quick start (local)





## Documentation map

| Doc | What it covers |
|---|---|
| `CLAUDE.md` | Hard safety rules, architecture gotchas, commands |
| `docs/SERVER_SETUP.md` | Hosting, logins, client links, Stripe payments |
| `docs/DEVELOPER_ONBOARDING.md` | Full dev handoff: flows, tables, SaaS split map |
| `docs/HANDOFF.md` | Running state, open issues, verify-after-pull checklist |
| `docs/products/` | Sellable-product packets (Plan Review API is live-ready) |

## Safety (never regress)

Automation never pays portal fees and never solves CAPTCHA/MFA. The portal's
final submit is clicked by a human, or by automation only under the one gate
(`mayClickFinalSubmit`: a named person's approval of exactly that run, plus
`PORTAL_ALLOW_FINAL_SUBMIT=1` on the process, plus a valid recipe shape);
secrets never reach the LLM; human-verified knowledge is never
auto-overwritten. See `CLAUDE.md`.

## Test suites

`npm run typecheck` · `npm run smoke` · `npm run backend:test:unit` ·
`npm run portal:test:unit` · `npm run portal:test:specs` (real-browser
PowerClerk cascade) · `npm run import:reference -- <files.xlsx>` (KB imports)
