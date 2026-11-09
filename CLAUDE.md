# Working on this repository

**Supertext Plugin Health** (this repo, formerly *Commando Center*): the dashboard that collects version reports from all Supertext plugins and shows them to Supertext staff (Next.js 16 + PostgreSQL, Railway). Part of Supertext's translation plugins project; the shared conventions (docs, repo setup, checks, releases, dependency updates) apply here too.

## Always

- **Docs in the same commit:** `docs/INSTALLATION.md` (deploy, settings, troubleshooting), `docs/USER_GUIDE.md` (staff using the dashboard, with screenshots), `docs/DEVELOPER.md` (report protocol, architecture, tests, releasing). `CHANGELOG.md` gets an entry under *Unreleased* for every visible change; `README.md` stays a short overview.
- **The report protocol is a contract with ~30 plugins.** `spec/` (schema, examples, URL vectors) and `docs/DEVELOPER.md` → *Report protocol* change together, only in backward-compatible ways (new optional fields, new events). Plugins in the field never update in step with the dashboard. A breaking change needs `schema: 2` and keeps accepting 1.
- The plugin side of the protocol is the **Plugin Health library** in `plugin-health/` (TypeScript reference, PHP, Python, .NET, Java). A protocol change updates `spec/`, `plugin-health/spec/reporter.json`, all five languages, their tests and `plugin-health/CHANGELOG.md` in the same commit. It needs nothing from the Supertext SDK except the key check the plugin passes in (`checkApiKey()`, `apiKeyFingerprint()`, `SDK_VERSION` in `Supertext-API-SDK-and-Guide`): those names and the check's fields must not change there. Commands per language: `plugin-health/README.md` → *Working on it*. TypeScript lockfile: create it with `npx npm@11 install` (npm 10 crashes on Vitest 5's optional peers).
- UI changes: regenerate the screenshots with `npm run docs:screenshots` (see the developer guide).
- Every page and server action calls `requireAuth()`; only `/api/v1/report`, `/health`, `/login` and the sign-in routes `/auth/login`, `/auth/callback` are public; `/api/v1/stats` needs `COMMANDO_STATS_TOKEN` and returns totals only (never sites, clients or notes). Staff sign in with Supertext accounts (OIDC, Person Service, `src/lib/oidc.ts`, developer guide → *Sign-in*): keep the PKCE/state/nonce and every ID token check, the staff rule, and outgoing requests only to the issuer's origin; never log codes, tokens, names or e-mail addresses.
- Never log or store API keys, passwords, session secrets or report senders' IP addresses.
- **The callback ping connects to URLs from unauthenticated reports.** Never weaken `src/lib/callback.ts`: host must match the site, private/reserved addresses refused at connect time, no redirects, timeouts and size caps. Every new outgoing request goes through the same guard. `COMMANDO_PING_ALLOW_PRIVATE` / `COMMANDO_PING_HOSTS` are test-only and must never reach production.
- The UI is for Supertext staff and stays in English (the plugins' own UI is the one in four languages).

## Before committing

`npm run typecheck && npm test && npm run test:integration` (Postgres on 127.0.0.1:5432, see the developer guide). Image changes: `docker build -t commando . && test/image-check.sh`. Workflow changes: `actionlint` and `zizmor --offline .github/workflows`.

## Releases

The Plugin Health library has its own releases: `plugin-health/CHANGELOG.md` + the same version in all five languages (`plugin-health/scripts/check-versions.sh`) → tag `plugin-health-vX.Y.Z`.

The dashboard: `.github/workflows/release.yml` publishes when `CHANGELOG.md` gets a new `## [X.Y.Z] - YYYY-MM-DD` section and `package.json` has the same version. Never tag by hand. Railway deploys every push to `main`.

## Dependency updates

Keep TypeScript 5 and `@types/node` 22 (Dependabot ignores their majors; see the developer guide). npm 10's arborist crashes on Vitest 4 next to Next 16 (`edgesOut`); Vitest 5 is fine.
