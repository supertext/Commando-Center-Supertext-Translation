# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Renamed from *Commando Center* to **Supertext Plugin Health**, like the library the plugins use to report to it. Only the name changes: settings (`COMMANDO_*`), cookies, the database, the repository and the address stay the same. The suggested Person Service client ID is `Supertext.PluginHealth`.
- **Sign in with your Supertext account** (OpenID Connect against Supertext's Person Service, authorization code with PKCE): only accounts with the `Administrator` role (or addresses set in `COMMANDO_OIDC_ALLOWED_EMAILS`) get in; 12-hour sessions; your name in the header; *Sign out* also signs out of the Supertext login. New settings `COMMANDO_OIDC_ISSUER`, `COMMANDO_OIDC_CLIENT_ID`, `COMMANDO_SESSION_SECRET` (and optional `COMMANDO_OIDC_CLIENT_SECRET`, `…_ALLOWED_ROLES`, `…_ALLOWED_EMAILS`, `…_SCOPES`, `COMMANDO_PUBLIC_URL`). The shared password `COMMANDO_PASSWORD` is now an optional fallback. Existing sessions end once (new cookie format). The installation guide has the client registration for the Person Service.
- Next.js 16.4.5 (security fixes).
- Supertext's look, as in the HubSpot app: deep-green header with rounded corners and the mint Supertext logo (also on the login page), warm off-white background, mint for the main action, the active tab and good states, pill buttons, tabs and filters, Inter bundled in `public/fonts/` (SIL OFL) and the S mark as favicon. One light theme (the dark variant is gone). Screenshots updated.

### Added

- *Translation proxy* tab: which plugins (name, version with release status, SDK) send their translations through the Supertext translation proxy, per customer, with uploads, uploads answered from the proxy's memory, key checks and first/last request. Read from the proxy's usage API (`COMMANDO_PROXY_URL`, `COMMANDO_PROXY_TOKEN`); usage only, translations and review links stay in the proxy.
- **Supertext Plugin Health** (`plugin-health/`): the plugin side of the report protocol in TypeScript, PHP, Python, .NET and Java, moved here from the Supertext SDK (0.1–0.2; removed in SDK 0.3.0). The reporter takes the SDK's key check as a parameter instead of creating an SDK client; the stored state is unchanged. Shared vectors `plugin-health/spec/reporter.json`, CI per language, its own releases (`plugin-health-vX.Y.Z`), and a contract test that the center accepts every report the reference builds.
- Callback ping: reports can carry `callback.url`, the plugin's public ping endpoint. The center pings it after a report (at most once a minute per site; again after 6 hours) and on **Ping now**, and records *reachable* (with latency), *not reachable*, *blocked*, *wrong answer* or *refused*, with a ping history per installation. A list column, a *Not reachable* filter and a count show the result. Safety: the endpoint must be on the site's host, private and reserved addresses are refused at connect time, no redirects, 5 s timeout, 4 KB answer. `spec/callback-vectors.json` defines the URL rules and the endpoint's answer.
- *Runtime* now shows under *System* in the installations list, to make room.
- API key check: reports can carry `api_key_check` (status `ok`, `invalid`, `missing`, `unreachable` or `error`, with time, HTTP status and Supertext's error code) and the new event `api_key_check`. The installations list shows the latest result per site with a filter (*Key problem*, …) and a count; the installation page shows it with its history (*API key rejected → ok*). A malformed check is ignored without losing the report; an older check never replaces a newer one. The developer guide defines when every plugin checks its key automatically and the messages in four languages.
- Report endpoint `POST /api/v1/report` (protocol v1, `spec/report-v1.schema.json`): plugins report their site URL, plugin, system, runtime and SDK versions and why (`installed`, `settings_saved`, `upgraded`, `check`). Site URLs are normalized; local and test hosts are flagged. Bodies up to 8 KB, 60 reports per minute per IP.
- Installations list with counts, search and filters (plugin, client, *update available*, local hosts); plugin versions compared with the latest GitHub release of each plugin.
- Installation page with the latest report, client mapping, notes and the history of all reports with what changed (e.g. *WordPress 6.8.3 → 6.9.0*).
- Clients: create, rename, notes, delete; map installations to clients by hand.
- Login with one shared password (`COMMANDO_PASSWORD`), signed 14-day session cookie, login rate limit.
- PostgreSQL migrations at every start; `COMMANDO_DB_NAME` creates and uses an own database on a shared server.
- Docker image for Railway with `/health`; the center's version in the footer, linked to its release.
- Installation, user and developer guides with screenshots; unit and integration tests, image check and CI.
