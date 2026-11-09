# Installation guide

How to run the Supertext Plugin Health dashboard: requirements, deployment on Railway, settings, updates and troubleshooting. For using the dashboard, see the [user guide](USER_GUIDE.md); for the report protocol and development, the [developer guide](DEVELOPER.md).

## Requirements

- A container host. The dashboard runs on [Railway](https://railway.com) in the Supertext project; any Docker host works.
- PostgreSQL 14 or later. On Railway, the shared Postgres service is used; the dashboard creates its own database on it.
- A client registration in Supertext's Person Service (the Supertext login), so staff sign in with their Supertext accounts. See *Sign-in with Supertext accounts* below.
- A domain the plugins can reach over HTTPS. The plugins send reports to `https://<domain>/api/v1/report`, and that address ships in every plugin, so use a domain Supertext controls (`pluginhealth.supertext.com`, the default in Plugin Health 0.2), not the generated Railway domain. Plugins bundled with Plugin Health 0.1 report to `commandocenter-production.up.railway.app`: keep that Railway domain on the service as long as such plugins are installed.

## Deploy on Railway

1. In the Supertext Railway project, create a service from the GitHub repository `Supertext/Commando-Center-Supertext-Translation` (branch `main`). Railway builds the `Dockerfile` at the repo root.
2. Region: **ams** (Amsterdam), one replica.
3. Variables (see *Settings* below): at least `DATABASE_URL` (reference the shared Postgres: `${{Postgres.DATABASE_URL}}`), `COMMANDO_DB_NAME=commando`, and for signing in `COMMANDO_OIDC_ISSUER`, `COMMANDO_OIDC_CLIENT_ID` and `COMMANDO_SESSION_SECRET`.
4. Healthcheck path: `/health` (answers `ok` when the app reaches its database). Restart policy: on failure.
5. Networking: add the custom domain and the DNS record Railway shows (CNAME). Railway issues the certificate.
6. Deploy. On the first start the log shows `migrate: created database commando` and `migrate: applied 001_init.sql`.

Every push to `main` deploys again. Migrations run on every start and only apply what's new.

## Settings

All settings are environment variables (Railway service variables).

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | – | Postgres connection URL (`postgresql://user:password@host:5432/railway`) |
| `COMMANDO_DB_NAME` | no | the database in `DATABASE_URL` | The dashboard's own database on that server; created on the first start. Letters, digits and `_` only |
| `COMMANDO_OIDC_ISSUER` | for Supertext sign-in | – | The Person Service: `https://www.supertext.com/person` (production). https only |
| `COMMANDO_OIDC_CLIENT_ID` | for Supertext sign-in | – | The client registered in the Person Service, e.g. `Supertext.PluginHealth.Admin.UI` |
| `COMMANDO_OIDC_CLIENT_SECRET` | no | – | Only if the client is registered with a secret (`RequireClientSecret: true`). The usual staff-app setup is PKCE without a secret |
| `COMMANDO_SESSION_SECRET` | for Supertext sign-in | – | Random string of at least 32 characters (`openssl rand -base64 48`) that signs the session cookies. Changing it signs everyone out |
| `COMMANDO_OIDC_ALLOWED_ROLES` | no | `Administrator` | Person Service roles that may sign in (comma-separated, case-insensitive). `Administrator` is the role of Supertext staff. Set it to an empty value to allow only the addresses below |
| `COMMANDO_OIDC_ALLOWED_EMAILS` | no | – | Additional people by e-mail address or domain (`ada@supertext.com, @supertext.com`), for staff without the role |
| `COMMANDO_OIDC_SCOPES` | no | `openid profile email custom.profile` | Scopes requested. `custom.profile` carries the `role` claim |
| `COMMANDO_PUBLIC_URL` | no | from the request | The dashboard's public address (`https://pluginhealth.supertext.com`), used for the callback and sign-out addresses. Set it when the dashboard has a custom domain |
| `GITHUB_TOKEN` | no | – | A GitHub token (no scopes needed for public repositories). Without it, the release lookup is limited to 60 GitHub API requests per hour, which is enough for normal use |
| `GITHUB_OWNER` | no | `supertext` | GitHub owner of the plugin repositories (a plugin whose repository has another name than the plugin name it reports, like `supertext-wordpress-polylang` → `Wordpress-Polylang-Supertext-Translation`, is mapped in `src/lib/releases.ts`) |
| `COMMANDO_PROXY_URL` | no | – | Public base URL of the Supertext translation proxy, for the *Translation proxy* tab (e.g. `https://review-proxy.up.railway.app`) |
| `COMMANDO_PROXY_TOKEN` | with `COMMANDO_PROXY_URL` | – | The proxy's `REVIEW_USAGE_TOKEN`. Keep it only in Railway's variables |
| `COMMANDO_TIMEZONE` | no | `Europe/Zurich` | Time zone for dates in the UI |
| `PORT` | no | `8080` | Port the server listens on (Railway sets it) |
| `COMMANDO_PING_ALLOW_PRIVATE`, `COMMANDO_PING_HOSTS` | **never in production** | – | Test-only switches for the callback ping (local test servers, docs screenshots). They let the dashboard connect to private addresses; see the developer guide |

Keep the session secret and a client secret only in Railway's variables: never in the repository, in chat or in tickets.

## Sign-in with Supertext accounts

Staff sign in with their Supertext account through Supertext's Person Service (OpenID Connect, the same login as Supertext's other admin tools). Only people with the role `Administrator` in the Person Service (or an address in `COMMANDO_OIDC_ALLOWED_EMAILS`) get in; everyone else sees *Your Supertext account isn't allowed to use Plugin Health*. A session lasts 12 hours. *Sign out* ends the session here and at the Person Service.

1. **Register the client in the Person Service** (repository `Supertext.Person`, Azure DevOps): add this entry to `IdentityServer.Clients` in `Supertext.Person.Web/charts/appsettings/appsettings.Starprod.k8s.sn.json` (and in the other environments' files if the dashboard should sign in against them), with the dashboard's address:

   ```json
   {
     "Enabled": true,
     "ClientId": "Supertext.PluginHealth.Admin.UI",
     "ClientName": "Plugin Health Admin UI",
     "AllowedGrantTypes": [ "authorization_code" ],
     "RequireClientSecret": false,
     "RequirePkce": true,
     "AllowOfflineAccess": false,
     "RedirectUris": [ "https://pluginhealth.supertext.com/auth/callback" ],
     "PostLogoutRedirectUris": [ "https://pluginhealth.supertext.com/login" ],
     "AllowedScopes": [ "openid", "profile", "email", "custom.profile" ],
     "RequireConsent": false,
     "AlwaysIncludeUserClaimsInIdToken": true,
     "AccessTokenLifetime": 300
   }
   ```

   Deploy the Person Service. The dashboard only reads the user's name, e-mail address and roles; it calls no Supertext API with the access token.
2. **Set the variables** on the Railway service: `COMMANDO_OIDC_ISSUER=https://www.supertext.com/person`, `COMMANDO_OIDC_CLIENT_ID=Supertext.PluginHealth.Admin.UI`, `COMMANDO_SESSION_SECRET=<openssl rand -base64 48>` and, with a custom domain, `COMMANDO_PUBLIC_URL`. Railway redeploys.
3. **Check**: open the dashboard, *Sign in with Supertext*, sign in with a staff account.

To give a colleague access, give their Person Service account the `Administrator` role, or add their address to `COMMANDO_OIDC_ALLOWED_EMAILS`. To take it away, remove the role; their current session ends within 12 hours (change `COMMANDO_SESSION_SECRET` to end all sessions at once).

## What the dashboard receives and stores

Per report: the site URL, the plugin name and version, the system name and version, the runtime name and version, the SDK version, whether an API key is set, the result of the plugin's automatic API key check (status, time, HTTP status and Supertext's error code), the address of the plugin's ping endpoint, and why the report was sent (`installed`, `settings_saved`, `upgraded`, `api_key_check`, `check`). For each callback ping: time, result, HTTP status, latency and a short reason. No content, no API keys, no user names or e-mail addresses. The sender's IP address is used for the rate limit in memory and not stored. Clients and notes are entered by Supertext staff.

The dashboard makes outgoing requests only to the plugins' ping endpoints (on each site's own host, never private addresses), to the GitHub API and, for signing in, to the Person Service (`COMMANDO_OIDC_ISSUER`). For signed-in staff it keeps their Person Service ID, name and e-mail address in the session cookie in their browser; nothing about them is stored in the database or logged. Its outgoing IP address on Railway isn't fixed.

Plugins send reports by default; administrators can turn it off in each plugin's settings (*Send version information to Supertext*). Each plugin's installation guide documents this.

## Update

Push to `main` (or merge a pull request): Railway builds and deploys, migrations run at start. To roll back, redeploy an earlier deployment in Railway; migrations are only ever added, so an older version runs on a newer database as long as no migration removed something it needs (check `migrations/` before rolling back across one).

## Backup

The data lives in the `commando` database on the shared Postgres service and is covered by its backups. A manual backup: `pg_dump "$DATABASE_URL_WITH_COMMANDO_DB" > commando.sql`.

## Uninstall

Delete the Railway service, then the database: `DROP DATABASE commando;` on the Postgres service. Plugins that still report get no answer; that never affects them (reports are fire-and-forget).

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| Login says *Login is not configured* | `COMMANDO_OIDC_ISSUER` or `COMMANDO_OIDC_CLIENT_ID` is missing |
| Login says *Sign-in with a Supertext account is not configured correctly* | The message names the variable: usually `COMMANDO_SESSION_SECRET` missing or shorter than 32 characters |
| Login says *COMMANDO_PUBLIC_URL must be an https URL* | Set it with `https://`, e.g. `https://pluginhealth.supertext.com`: the Person Service only sends people back to the registered https address, and browsers don't keep the session cookie over http |
| The Person Service shows *invalid_request* / *unauthorized client* or *invalid redirect_uri* | The client isn't registered in that environment, or its `RedirectUris` don't contain exactly `<center address>/auth/callback`. With a custom domain, set `COMMANDO_PUBLIC_URL` and register that address |
| *Your Supertext account isn't allowed to use Plugin Health* | The account has no `Administrator` role (and its address isn't in `COMMANDO_OIDC_ALLOWED_EMAILS`). The log says `sign-in refused: not allowed by the staff rule` |
| *Signing in with Supertext didn't work* | The log line `sign-in failed: …` gives the reason (no names or tokens): e.g. `id_token audience mismatch` (wrong client ID) or `HTTP 400 from /person/connect/token` (client setup in the Person Service) |
| *Supertext's login service can't be reached* | The dashboard couldn't fetch `<issuer>/.well-known/openid-configuration`. Check `COMMANDO_OIDC_ISSUER` and that the Person Service is up. While it is down, nobody can sign in |
| *The sign-in took too long or was started in another browser* | The sign-in has to finish within 10 minutes in the same browser. Start again |
| After *Sign out*, the Person Service shows its own *logged out* page | `PostLogoutRedirectUris` doesn't contain `<center address>/login` |
| *Too many attempts* on login | 10 attempts per 15 minutes per IP address. Wait, or restart the service |
| Healthcheck fails, log shows `DATABASE_URL is not set` | Set the variable (reference the Postgres service) |
| A push to `main` doesn't deploy | Railway's GitHub app has no access to this repository: under https://github.com/organizations/Supertext/settings/installations → Railway → Configure, add `Commando-Center-Supertext-Translation`. Then reconnect the service's source once (Railway → service → Settings → Source), so Railway creates its push trigger again |
| Log shows `permission denied to create database` | The Postgres user can't create databases: create `commando` by hand, or leave `COMMANDO_DB_NAME` empty and point `DATABASE_URL` at an existing database |
| Every plugin version shows *no release* | GitHub can't be reached or the rate limit is used up: set `GITHUB_TOKEN`. Plugins without any GitHub release also show *no release* |
| Every installation shows *not checked* under API key | Expected until the plugins have the version that checks the key; older plugin versions don't send a check |
| Every installation shows *no endpoint* under Reachable | Expected until the plugins have the version with the ping endpoint |
| Every installation shows *not reachable* | The dashboard can't make outgoing connections: check Railway's networking for the service |
| An installation appears twice | The plugin reported different URLs (e.g. with and without `www`). Delete the one that no longer reports |
| No installations appear | Plugins report only once they have the reporting version and their settings are saved or they are updated. Send a test report (see the developer guide) to check the endpoint |
