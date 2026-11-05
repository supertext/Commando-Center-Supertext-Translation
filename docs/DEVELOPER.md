# Developer guide

Plugin Health collects version reports from the Supertext plugins and shows them to Supertext staff: which site runs which plugin version on which system and runtime version, whether its API key works, whether the site is reachable from the internet, and since when. This guide covers the report protocol (what every plugin implements), the app's architecture, local setup, tests, deployment and releasing.

The dashboard was called *Commando Center* until November 2026. Technical names kept the old name so nothing breaks: the `COMMANDO_*` settings, the cookies `commando_*`, the database `commando`, the image check's image `commando`, the repository `Commando-Center-Supertext-Translation`, the Railway service and its address (which ships in every plugin as the report URL), and the user agent `Supertext-Commando-Center/…` of the ping. The plugins' library in `plugin-health/` is the *Plugin Health library*.

## Architecture

- **Next.js 16** (App Router, server components and server actions), TypeScript, Node.js 22, built as a standalone server (`output: 'standalone'`).
- **PostgreSQL** through [`postgres`](https://github.com/porsager/postgres) (no ORM). Plain SQL migrations in `migrations/`, applied by `scripts/migrate.mjs` before every start.
- **Sign-in with Supertext accounts** through Supertext's Person Service (OpenID Connect, see *Sign-in* below). There is no other way in (no shared password). Every page and every server action calls `requireAuth()`. Only `/api/v1/report`, `/health`, `/login`, `/auth/login` and `/auth/callback` are public.
- **Latest releases** come from the GitHub API (`Supertext/<plugin>` → newest non-draft release, pre-releases included, because 0.x versions are published as pre-releases). Cached for an hour in memory; errors are cached for 10 minutes. `GITHUB_TOKEN` raises the rate limit.

| Path | What it is |
| --- | --- |
| `src/app/api/v1/report/route.ts` | The report endpoint |
| `src/app/page.tsx` | Installations list with filters and counts |
| `src/app/installations/[id]/page.tsx` | One installation: latest state, client mapping, notes, history |
| `src/app/clients/…` | Clients list and client page |
| `src/app/actions.ts` | Server actions (login, mapping, edits, deletes) |
| `src/app/layout.tsx`, `globals.css`, `src/components/main-nav.tsx` | Header, tabs and footer; the stylesheet (see *Look and feel*) |
| `public/` | `supertext-logo.svg`, `favicon.svg`, `fonts/` (Inter, SIL Open Font License); served as static files without login |
| `src/lib/report.ts` | Validates a report body |
| `src/lib/site-url.ts` | Normalizes the site URL, recognizes local and test hosts |
| `src/lib/db.ts` | All queries |
| `src/lib/db-url.mjs` | Database URL from `DATABASE_URL` + `COMMANDO_DB_NAME`, shared by the app and the migrations |
| `src/lib/auth.ts`, `session.ts` | Signed session cookie, `requireAuth()`, `currentUser()` |
| `src/lib/oidc.ts`, `oidc-cookies.ts`, `src/app/auth/{login,callback}/route.ts` | Sign-in with a Supertext account (OIDC): discovery, PKCE, ID token check, staff rule, sign-out at the Person Service |
| `scripts/oidc-stand-in.mjs` | A stand-in Person Service for local development, the screenshots and the image check |
| `src/lib/callback.ts` | The callback ping: URL check, address blocklist, the request itself |
| `src/lib/pinger.ts` | When to ping (throttle, re-ping), stores the result |
| `src/lib/releases.ts`, `semver.ts` | Latest GitHub release per plugin and version comparison |
| `src/lib/proxy-usage.ts`, `src/app/proxy/page.tsx` | *Translation proxy* tab: which plugins use the translation proxy (see below) |
| `spec/` | Protocol schema and test vectors, shared with Plugin Health |
| `plugin-health/` | **Supertext Plugin Health**, the plugin side of the protocol in TypeScript, PHP, Python, .NET and Java (see below) |

### Data model

- `installations`: one row per **normalized site URL + plugin** with the latest reported state (including the newest API key check), the client it is mapped to, notes, first and last report.
- `reports`: every report received (event, versions, the key check if the report had one, `changed` = differs from the previous state). The history on the installation page reads from here.
- `callback_pings`: every callback ping (time, trigger `report` or `manual`, URL, result, HTTP status, latency, detail); the installation keeps the latest result.
- `clients`: Supertext customers, created by hand. Names are unique regardless of case. Deleting a client unmaps its installations; deleting an installation deletes its history.

## Look and feel

The pages follow supertext.com, like the HubSpot app: the deep-green header bar (`#003230`, rounded bottom corners) with Supertext's mint logo (`public/supertext-logo.svg`, the website's own SVG) and *Plugin Health* next to it, the warm off-white background (`#f7f5f3`), deep-green text and outlines, mint (`#78ffaf`) for the main action, the active tab and good states (*latest*, *key ok*, *reachable*), light grey lines (`#dfe1df`), and pill-shaped buttons, tabs and filters. Text is set in Inter, bundled in `public/fonts/` (variable font, Latin and Latin Extended; SIL Open Font License in `Inter-LICENSE.txt`) and declared with `@font-face` in `src/app/globals.css`, so no font is loaded from elsewhere. Supertext's heading font (ABC Ginto Nord) is licensed and not bundled; headings use Inter Bold. The colours are CSS variables at the top of `globals.css`; there is one light theme. Focus rings are deep green on the page and mint in the header. The favicon is the logo's S mark on deep green. The login page shows the header with the logo only. The Docker image copies `public/` next to the standalone server.

## Report protocol

Every Supertext plugin implements this. The JSON schema is `spec/report-v1.schema.json`; `spec/report-examples.json` and `spec/site-url-vectors.json` are the shared test vectors. Plugins don't implement it themselves: they bundle [Supertext Plugin Health](../plugin-health/README.md), which builds and sends the reports, keeps the state and answers the ping.

### Request

```http
POST https://<center>/api/v1/report
Content-Type: application/json

{
  "schema": 1,
  "event": "upgraded",
  "site_url": "https://www.example.ch/",
  "plugin": { "name": "supertext-wordpress-polylang", "version": "2.1.0" },
  "system": { "name": "WordPress", "version": "6.9.0" },
  "runtime": { "name": "PHP", "version": "8.3.12" },
  "sdk_version": "0.3.0",
  "api_key_configured": true,
  "api_key_check": { "status": "ok", "checked_at": "2026-10-13T09:15:00+02:00", "http_status": 200 },
  "callback": { "url": "https://www.example.ch/wp-json/supertext/v1/ping" }
}
```

| Field | Required | Content |
| --- | --- | --- |
| `schema` | yes | `1` |
| `event` | yes | `installed` (first report of an installation), `settings_saved`, `upgraded` (plugin, system or runtime version changed since the last report), `api_key_check` (the key check result changed outside a settings save, see *The API key check*), `check` (sent by a command or test). Lower case and `_`, at most 40 characters; other values are stored as given. |
| `site_url` | yes | The base URL of the installation, as the system knows it (WordPress `home_url()`, TYPO3 site base, Magento base URL of the default store, the shop domain for Shopify, …). Absolute `http`/`https`. |
| `plugin.name` | yes | The plugin's GitHub repository name (`Typo3-Supertext-Translation`). The dashboard reads the latest release from `github.com/Supertext/<name>`. |
| `plugin.version` | yes | From the plugin's official version source (see the conventions → *Releases*), never a second hardcoded copy. |
| `system.name`, `system.version` | name yes | The CMS, PIM, shop or application: `WordPress`, `TYPO3`, `Magento`, `Shopify`, … Use the system's own spelling. |
| `runtime.name`, `runtime.version` | no | `PHP`, `Node.js`, `Python`, `.NET`, `Java` and the full version. |
| `sdk_version` | no | Version of the bundled Supertext SDK (its `SDK_VERSION` constant). |
| `api_key_configured` | no | `true`/`false`. Never the key itself. |
| `callback.url` | no | The plugin's public ping endpoint (see *The callback ping*). Absolute http(s) URL on the site's host or a subdomain of it, at most 500 characters. A report without it keeps the stored one. |
| `api_key_check.status` | no | Result of the latest automatic key check: `ok`, `invalid` (Supertext answered 401/403), `missing` (no key set), `unreachable` (network error, timeout, HTTP 5xx), `error` (any other answer). Other values are stored as given. |
| `api_key_check.checked_at` | no | When the check ran, ISO 8601 with time zone. Missing, more than 5 minutes in the future or before 2020: the dashboard uses the time it received the report. |
| `api_key_check.http_status` | no | The HTTP status Supertext answered the check with |
| `api_key_check.error_code` | no | Supertext's error code from the response body, if any (at most 100 characters) |

Unknown fields are accepted and ignored, so later versions can add fields without breaking older centers. The body may be at most 8 KB; strings must not contain control characters. A malformed `api_key_check` is dropped and the rest of the report is stored, so a plugin bug there never loses the version information.

The installation keeps the **newest** key check: a report without one (an `upgraded` report, an older plugin version) or with an older `checked_at` leaves the stored result alone. A changed key status counts as a change in the history (*API key rejected → ok*).

### Response

| Status | Meaning | Plugin does |
| --- | --- | --- |
| 202 | Stored | Remember what was reported (see below) |
| 400 | Invalid report (`error` says why) | Log once at debug level; it's a plugin bug |
| 413, 415 | Too large / not JSON | Same as 400 |
| 429 | Too many reports from this IP (60 per minute) | Try again later |
| 503 | Center can't store right now | Try again later |

The body is `{"ok": true}` or `{"ok": false, "error": "…"}`. Plugins ignore any other fields: later versions may return, for example, remote checks to run.

The site URL identifies the installation. The dashboard lower-cases scheme and host, converts international domains to punycode, drops default ports, user info, query, fragment and trailing slashes, and keeps a sub-path (`https://example.com/de/shop`). Local and test hosts (`localhost`, private IPs, `*.test`, `*.local`, `*.localhost`, `*.ddev.site`, single-label names, …) are flagged and hidden by default. Same URL with two different plugins = two installations.

### When a plugin reports

1. **Settings saved.** After the administrator saves the plugin's settings and the automatic API key check has run, send `settings_saved` with its result in `api_key_check` — or `installed` if the plugin has never reported successfully.
2. **Upgrades.** The plugin stores the version set it last reported successfully: `"<plugin version>|<system version>|<runtime version>"`. On back-end requests that already run the plugin's code (its settings or status page, the translate action, a translation job, a CLI command), it compares the current set with the stored one. If they differ, it sends `upgraded`. This catches updates of the plugin, the system (e.g. WordPress 6.8 → 6.9) and the runtime (PHP 8.3 → 8.4) without relying on each system's update hooks. Don't check on front-end page views.
3. **Never block.** The report is fire-and-forget: at most 3 seconds timeout, no retries in the same request, errors only logged at debug level. A failed report never fails the save or the translation. Where the system offers it, send after the response (WordPress shutdown hook, Laravel/Symfony `kernel.terminate`, a queued job, `setImmediate`/background task).
4. **Throttle failures.** On failure, don't update the stored set and don't try again for an hour (store the time of the last attempt), so an unreachable center can't slow the back end down.
5. **Off means off.** With the setting off, send nothing — not even an "off" report.
6. **Server side only.** Reports go from the plugin's server code (or the hosted app's backend for Shopify and Wix), never from the editor's browser.

### The API key check

Every plugin checks the API key automatically, so administrators learn about a wrong key when they enter it, not when the first translation fails, and Supertext sees it in the dashboard. The check is the Supertext SDK's cost-free `checkApiKey()` (`GET features` against the Supertext API; no translation, nothing billed); Plugin Health's reporter calls it through the key checker the plugin passes in. It runs whether or not version reporting is on; only the report depends on the setting.

**When**

1. **Settings saved:** every time the plugin's settings are saved, after storing them. The result is shown on the settings page (messages below) and sent with the `settings_saved` report. An invalid key never blocks saving.
2. **Key from the environment or a config file** (Directus, Strapi, Ghost, …, where no save happens): on back-end requests, when the key differs from the one last checked. Compare a fingerprint (SHA-256 of the key, kept locally, never sent anywhere). Report `api_key_check`.
3. **A translation is rejected with 401 or 403:** set the status to `invalid` and report `api_key_check`, but only when the status changes (no report per failed translation).
4. **Test connection** (where the plugin has the button): run the same check and update the stored result; report `api_key_check` when the status changed.

**How**

- Timeout 10 seconds. Rate limit (429): the SDK's usual retries, then `error` with `http_status: 429`.
- Map the result: 2xx → `ok`; 401, 403 → `invalid`; no key set → `missing` (no request); network error, timeout, 5xx → `unreachable`; anything else → `error` with `http_status` and Supertext's `error_code` if the body has one.
- Store locally: status, time, HTTP status, error code, key fingerprint. The status/settings page shows the last result with its time.
- Never log or send the key; `error_code` and `http_status` only.

**Messages** (placeholders like `{status}` untranslated; in the UI, *supertext.com* and *supertext.com → Integrations → API* link to https://www.supertext.com/person/en/account/signin and https://www.supertext.com/en/integrations/api in a new tab):

| Result | en | de | fr | it |
| --- | --- | --- | --- | --- |
| `ok` | API key checked: the connection to Supertext works. | API-Schlüssel geprüft: Die Verbindung zu Supertext funktioniert. | Clé API vérifiée : la connexion à Supertext fonctionne. | Chiave API verificata: la connessione a Supertext funziona. |
| `invalid` | Supertext rejected the API key. Check that you copied the whole key, or generate a new one at supertext.com → Integrations → API (requires the Admin role). No Supertext account yet? Create one at supertext.com. | Supertext hat den API-Schlüssel abgelehnt. Prüfen Sie, ob Sie den ganzen Schlüssel kopiert haben, oder erstellen Sie einen neuen unter supertext.com → Integrations → API (erfordert die Rolle Admin). Noch kein Supertext-Konto? Erstellen Sie eines auf supertext.com. | Supertext a refusé la clé API. Vérifiez que vous avez copié la clé entière ou générez-en une nouvelle sur supertext.com → Integrations → API (rôle Admin requis). Pas encore de compte Supertext ? Créez-en un sur supertext.com. | Supertext ha rifiutato la chiave API. Verifichi di aver copiato l'intera chiave oppure ne generi una nuova su supertext.com → Integrations → API (richiede il ruolo Admin). Non ha ancora un account Supertext? Ne crei uno su supertext.com. |
| `missing` | No API key is set yet. No Supertext account yet? Create one at supertext.com. Generate your API key at supertext.com → Integrations → API (requires the Admin role). | Es ist noch kein API-Schlüssel eingetragen. Noch kein Supertext-Konto? Erstellen Sie eines auf supertext.com. Ihren API-Schlüssel erstellen Sie unter supertext.com → Integrations → API (erfordert die Rolle Admin). | Aucune clé API n'est encore saisie. Pas encore de compte Supertext ? Créez-en un sur supertext.com. Générez votre clé API sur supertext.com → Integrations → API (rôle Admin requis). | Non è ancora stata inserita alcuna chiave API. Non ha ancora un account Supertext? Ne crei uno su supertext.com. Generi la Sua chiave API su supertext.com → Integrations → API (richiede il ruolo Admin). |
| `unreachable` | The API key couldn't be checked because Supertext can't be reached. The settings are saved; check again later. | Der API-Schlüssel konnte nicht geprüft werden, weil Supertext nicht erreichbar ist. Die Einstellungen sind gespeichert; prüfen Sie ihn später erneut. | La clé API n'a pas pu être vérifiée, car Supertext n'est pas joignable. Les paramètres sont enregistrés ; réessayez plus tard. | Non è stato possibile verificare la chiave API perché Supertext non è raggiungibile. Le impostazioni sono salvate; riprovi più tardi. |
| `error` | The API key couldn't be checked: Supertext answered with an error ({status}). The settings are saved; check again later. | Der API-Schlüssel konnte nicht geprüft werden: Supertext hat mit einem Fehler geantwortet ({status}). Die Einstellungen sind gespeichert; prüfen Sie ihn später erneut. | La clé API n'a pas pu être vérifiée : Supertext a répondu par une erreur ({status}). Les paramètres sont enregistrés ; réessayez plus tard. | Non è stato possibile verificare la chiave API: Supertext ha risposto con un errore ({status}). Le impostazioni sono salvate; riprovi più tardi. |

Plugins that already have a *Test connection* button and an *authentication failed* message keep their wording if it carries both links; the table is for plugins that don't have one yet.

### The callback ping

So that Supertext can later call installations back (e.g. "translation ready"), the dashboard checks whether each installation is reachable from the internet: it calls the plugin's ping endpoint and checks the answer.

**The plugin's endpoint**

- A public route that needs no login, no session and no CSRF token, excluded from the CMS's page cache, answering only `GET`. Suggested paths: WordPress `/wp-json/supertext/v1/ping`, TYPO3 an eID or middleware path, Joomla `index.php?option=com_ajax&plugin=supertext&format=json`, Magento `/rest/V1/supertext/ping`, Node CMSs `/supertext/ping` under their API prefix. The plugin sends the full URL in `callback.url`, built from the site's own base URL.
- Request: `GET <url>?challenge=<c>` (or `&challenge=` when the URL already has a query). `c` matches `^[A-Za-z0-9_-]{16,64}$`; anything else gets HTTP 400 `{"ok":false}`, so nothing a caller sends is reflected.
- Answer: HTTP 200, `Content-Type: application/json`, `Cache-Control: no-store`, body `{"ok":true,"plugin":"<repo name>","challenge":"<c>"}`. Nothing else: no versions, no settings, no data. The answer is the same for everyone; there is nothing to protect.
- Only while version reporting is on. With reporting off: HTTP 404 and no `callback` in reports.
- Hosted apps (Shopify, Wix) and plugins without a server part (the design-file scripts) send no `callback`.
- `spec/callback-vectors.json` → `endpoint` has the cases Plugin Health's `pingResponse()` tests run.

**The dashboard's ping**

- When: after a report with `callback.url`, once the answer has been sent (Next.js `after()`), when the URL is new, the event is `installed`, `settings_saved` or `check`, or the last ping is more than 6 hours old. Never more than once a minute per installation, at most 8 pings at once. Staff can press **Ping now** on the installation page. Local and test hosts are never pinged.
- Safety (the URL comes from an unauthenticated report, so the dashboard must not become a tool for probing other hosts or its own network): the URL's host must be the site's host or a subdomain of it (a leading `www.` of the site is ignored); `http`/`https` only, no user info; port 80, 443 or the site's own port. Every address the host resolves to is checked when the socket connects (no DNS rebinding), IP literals before: loopback, private, link-local (including cloud metadata `169.254.169.254`), CGNAT (`100.64.0.0/10`), unique-local IPv6 (Railway's private network), multicast and reserved ranges are refused. `GET` only, no redirects followed, no cookies, 5 s timeout, at most 4 KB read, TLS certificates verified. User agent `Supertext-Commando-Center/<version> (+https://github.com/Supertext/Commando-Center-Supertext-Translation)`.
- Results: `reachable` (HTTP 200 and the challenge echoed by the right plugin; latency stored), `unreachable` (DNS, connection, timeout, TLS), `blocked` (any non-2xx, including redirects to a login page), `wrong_answer` (2xx but not the plugin's answer: a cache, maintenance or firewall page, another plugin), `refused` (the dashboard didn't connect: other host, port or a private address). Each result has a short plain `detail` ("HTTP 302 to /wp-login.php", "connection timed out").
- The dashboard's outgoing IP addresses aren't fixed (Railway). Customers who only let known addresses in can't allow it yet; see the roadmap.

**Test-only switches** (never set in production; the image check makes sure the image doesn't set them): `COMMANDO_PING_ALLOW_PRIVATE=1` allows private addresses, `COMMANDO_PING_HOSTS=host=ip[:port],…` connects to fixed addresses instead of DNS (the `Host` header and TLS name stay the real host). The integration tests and `npm run docs:screenshots` use them.

### The setting in the plugins

Every plugin has this setting, **on by default**, next to its other settings (environment variable `SUPERTEXT_VERSION_REPORTS=0` turns it off where settings live in the environment, e.g. Directus, Strapi, Ghost; the plugin's settings file elsewhere). The URL of the dashboard can be overridden for tests with `SUPERTEXT_REPORT_URL`; the default is in Plugin Health.

Strings (use the CMS's own word for the system instead of *CMS* where it has one: shop, PIM, …):

| | Label | Help text |
| --- | --- | --- |
| en | Send version information to Supertext | Sends the site URL and the versions of this plugin, the CMS and the runtime to Supertext when you save these settings and after an update, so Supertext support can see which version you run. No content, no API key and no personal data are sent. |
| de | Versionsinformationen an Supertext senden | Sendet die URL der Website sowie die Versionen dieses Plugins, des CMS und der Laufzeitumgebung an Supertext, wenn Sie diese Einstellungen speichern und nach einem Update. So sieht der Supertext-Support, welche Version Sie einsetzen. Es werden keine Inhalte, kein API-Schlüssel und keine Personendaten übertragen. |
| fr | Envoyer les informations de version à Supertext | Envoie à Supertext l'URL du site ainsi que les versions de ce plugin, du CMS et de l'environnement d'exécution lorsque vous enregistrez ces paramètres et après une mise à jour. Le support Supertext voit ainsi quelle version vous utilisez. Aucun contenu, aucune clé API et aucune donnée personnelle ne sont transmis. |
| it | Inviare le informazioni sulla versione a Supertext | Invia a Supertext l'URL del sito e le versioni di questo plugin, del CMS e dell'ambiente di esecuzione quando salva queste impostazioni e dopo un aggiornamento. In questo modo l'assistenza Supertext vede quale versione utilizza. Non vengono trasmessi contenuti, chiavi API né dati personali. |

Each plugin's `docs/INSTALLATION.md` lists the setting with exactly what is sent and how to turn it off.

## Translation proxy usage

The *Translation proxy* tab shows which plugins send their translations through the Supertext translation proxy ([Localization-Review-Supertext-Translation](https://github.com/Supertext/Localization-Review-Supertext-Translation)), per proxy tenant (one Supertext API key, labelled in the proxy): plugin and version (compared with the latest release like the installations), SDK, uploads, uploads the proxy answered from its memory, key checks, first and last request. The dashboard only shows usage: translations and review links stay in the proxy.

- Read server-side from the proxy's `GET /api/usage` (`Authorization: Bearer <COMMANDO_PROXY_TOKEN>`, the proxy's `REVIEW_USAGE_TOKEN`; schema in the proxy's developer guide → *Usage API*), 5 s timeout, no redirects, 2 MB cap, invalid entries dropped, cached for a minute in memory.
- `COMMANDO_PROXY_URL` is set by staff, like `GITHUB_API_URL`; it never comes from a report, so the callback ping's guard doesn't apply. Use the proxy's public URL.
- The proxy knows plugins by API key, not by site URL, so its rows aren't joined with the installations. Joining them would need the plugins to report their key fingerprint (a protocol change in Plugin Health).

## Supertext Plugin Health

`plugin-health/` holds the library every plugin bundles for this protocol, in TypeScript (the reference), PHP, Python, .NET and Java: `InstallationReporter` (reports, state, failure backoff), `reportsEnabled()` and `pingResponse()`. It needs nothing from the Supertext SDK: the plugin passes the SDK's key check (`checkApiKey()` + `apiKeyFingerprint()`) and `SDK_VERSION` in. Usage, API and bundling: [plugin-health/README.md](../plugin-health/README.md).

- Behaviour is pinned by `plugin-health/spec/reporter.json` (the reporter's scenarios, the setting, the ping answers) plus this repo's `spec/`. A protocol change here updates the spec, all five languages, their tests and `plugin-health/CHANGELOG.md` in the same commit.
- `test/unit/plugin-health.test.ts` replays the reporter scenarios with the TypeScript reference and runs every report body through the dashboard's own parser, so the client and the server can't drift apart.
- CI: `.github/workflows/plugin-health.yml` (every language, plus a check that all five carry one version: `plugin-health/scripts/check-versions.sh`). Releases: a new `## X.Y.Z — YYYY-MM-DD` section in `plugin-health/CHANGELOG.md` → `.github/workflows/plugin-health-release.yml` tags `plugin-health-vX.Y.Z` (0.x as pre-releases), independent of the dashboard's own releases.
- Plugins bundle a copy with `scripts/vendor-plugin-health.sh <tag or commit>`; never edit a copy.

## Sign-in

The Person Service (`Supertext.Person`, IdentityServer 4) is Supertext's OpenID Connect provider; production issuer `https://www.supertext.com/person`. The dashboard is a client like Supertext's other staff tools (Diffuso admin, SQL generator): authorization code flow with PKCE, no client secret (`COMMANDO_OIDC_CLIENT_SECRET` is supported if the client gets one). The registration snippet is in the installation guide.

1. `/auth/login` fetches the discovery document (cached an hour), creates `state`, `nonce` and a PKCE verifier, keeps them in the signed cookie `commando_oidc` (10 minutes, path `/auth`, HttpOnly, SameSite=Lax) and redirects to the authorize endpoint with scopes `openid profile email custom.profile`.
2. `/auth/callback` checks `state` and the cookie's age, exchanges the code at the token endpoint (with the verifier), and checks the ID token: signature against the issuer's JWKS (RS256/384/512, ES256/384; `none` and HMAC refused; keys re-fetched once when the `kid` is unknown), `iss`, `aud` (and `azp` with several audiences), `exp`/`iat` with 2 minutes' leeway, `nonce`, `sub`. Then it reads the userinfo endpoint and merges its claims if the `sub` matches (the role may come from either).
3. **Staff rule**: one of `COMMANDO_OIDC_ALLOWED_ROLES` (default `Administrator`, `Domain.Constants.Roles.Administrator` in the Person Service, the role its own admin pages require; it arrives in the `role` claim with the scope `custom.profile`), or an address or `@domain` from `COMMANDO_OIDC_ALLOWED_EMAILS` (not if `email_verified` is `false`). Others go back to `/login?error=denied`.
4. The session cookie `commando_session` is `v2.<payload>.<hmac>` with the Person Service `sub`, name and e-mail and the expiry (12 hours), signed with a key derived from `COMMANDO_SESSION_SECRET`. Sessions from the shared password the dashboard had until November 2026 are refused. The ID token is kept in `commando_idt` (HttpOnly, only if under 3.5 KB) solely as `id_token_hint` for signing out. No access or refresh token is kept.
5. *Sign out* deletes both cookies and redirects to the end-session endpoint with `post_logout_redirect_uri=<center>/login`.

Outgoing requests go only to the configured issuer: https (http only for `localhost`/`127.0.0.1`, for the stand-in), every endpoint from the discovery document must be on the issuer's origin, redirects are not followed, 10 s timeout, 256 KB per answer. The callback is rate-limited (30 per 15 minutes per IP). Logs say why a sign-in failed or was refused, never codes, tokens, names or addresses. The callback and sign-out addresses come from `COMMANDO_PUBLIC_URL`, else from `X-Forwarded-Host`/`-Proto` (the Person Service only accepts registered addresses anyway).

Locally, `node scripts/oidc-stand-in.mjs` serves a stand-in Person Service on `http://127.0.0.1:8767/person` whose login page offers two invented people: Ada Muster (Administrator, gets in) and Max Kunde (Customer, refused):

```bash
node scripts/oidc-stand-in.mjs &
COMMANDO_OIDC_ISSUER=http://127.0.0.1:8767/person COMMANDO_OIDC_CLIENT_ID=Supertext.PluginHealth.Admin.UI \
COMMANDO_SESSION_SECRET=local-session-secret-0123456789abcdef npm run dev
```

## Local setup

Needs Node.js 22 and a PostgreSQL server (any version from 14).

```bash
npm ci
cp .env.example .env.local      # then set DATABASE_URL and the sign-in (stand-in, see Sign-in)
npm run dev                     # applies migrations, then http://localhost:3000
```

Postgres in Docker: `docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`, then `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres` and `COMMANDO_DB_NAME=commando` (the app creates the database).

Send a report by hand:

```bash
curl -i -H 'Content-Type: application/json' \
  -d '{"schema":1,"event":"check","site_url":"https://www.example.ch","plugin":{"name":"Typo3-Supertext-Translation","version":"0.4.0"},"system":{"name":"TYPO3","version":"13.4.2"}}' \
  http://localhost:3000/api/v1/report
```

## Tests

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | TypeScript |
| `npm test` | Unit tests: URL normalization, report validation, the API key check and the callback URL check and address blocklist against `spec/`; real pings against local test servers (reachable, wrong answer, blocked, timeout, refused, DNS-rebinding style names); versions, sessions, the OIDC sign-in against a fake issuer (discovery, PKCE, every ID token check, userinfo, staff rule, sign-out URL), rate limit, database URL, release lookup |
| `npm run test:integration` | Migrations (twice), the store (including which key check an installation keeps), the report endpoint and the ping after a report (throttle, *Ping now*, blocked and refused endpoints) against a real Postgres and a local ping server. Needs `TEST_DATABASE_URL` (default `postgres://postgres:postgres@127.0.0.1:5432/postgres`); drops and recreates the database `commando_test` on it |
| `test/image-check.sh` | The Docker image: starts it twice against Postgres, checks health, the login redirect, the start of the Supertext sign-in against the stand-in Person Service, reports, migrations that the login page has no password field, and that the session secret never reaches the log |

CI (`.github/workflows/ci.yml`) runs all of them on every push and pull request, with Postgres 16 as a service.

## Docs screenshots

`npm run docs:screenshots` fills an empty center with invented sample sites and clients and saves the screenshots in `docs/images/`. It starts a stand-in on port 8766 for the GitHub releases API, the sample sites' ping endpoints, the translation proxy's usage API and the Person Service (it signs in as the invented Ada Muster), so start the dashboard against it first (with a fresh database and a fresh process: the ping throttle lives in memory):

```bash
GITHUB_API_URL=http://127.0.0.1:8766 COMMANDO_PROXY_URL=http://127.0.0.1:8766 COMMANDO_PROXY_TOKEN=docs-proxy-token \
COMMANDO_PING_ALLOW_PRIVATE=1 COMMANDO_PING_HOSTS="$(node scripts/docs-screenshots.mjs --ping-hosts)" \
COMMANDO_OIDC_ISSUER=http://127.0.0.1:8766/person COMMANDO_OIDC_CLIENT_ID=Supertext.PluginHealth.Admin.UI \
COMMANDO_SESSION_SECRET=local-session-secret-0123456789abcdef COMMANDO_DB_NAME=commando_docs npm run dev
COMMANDO_URL=http://127.0.0.1:3000 npm run docs:screenshots
```

Needs Playwright's Chromium (`npx playwright install chromium`, or `CHROME=/path/to/chrome`). Regenerate the screenshots in the same commit as UI changes.

## Deployment (Railway)

Railway builds the `Dockerfile` at the repo root. The image runs `scripts/migrate.mjs` and then the Next.js standalone server on `PORT` (8080 by default). Settings, the region and the healthcheck are set on the Railway service (Railway ignores `railway.json`); see `docs/INSTALLATION.md`.

Railway deploys every push to `main` through its GitHub app, which must have access to this repository (Supertext organization settings → Installations → Railway). After that access changes, reconnect the service's source once so Railway creates its push trigger again; until then, pushes build nothing and only a reconnect or a manual redeploy deploys.

## Dependency updates

Dependabot opens weekly pull requests (npm minor and patch grouped, GitHub Actions grouped, the Docker base image). Merge when CI is green. Not taken automatically:

- TypeScript 7 (native compiler): Next.js's type checking still needs 5.x.
- `@types/node` majors and the `node` image major: they follow the Node.js LTS line the image runs (22). Move both by hand.

## Code quality and security checks

- **Checks** workflow (`.github/workflows/checks.yml`): [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://docs.zizmor.sh/) lint the workflows on every push and pull request; dependency review fails a pull request that adds a package with a known vulnerability (moderate or worse). Actions are pinned to commit SHAs. Locally: `pip install actionlint-py zizmor`, then `actionlint` and `zizmor --offline .github/workflows`.
- **Links** workflow (`.github/workflows/links.yml`): [lychee](https://lychee.cli.rs/) checks the links in all Markdown files weekly and when docs change on `main`; broken links open the issue "Broken links in the docs".
- TypeScript is analysed by CodeQL default setup; secret scanning with push protection is on (both set by Remy's setup script).
- The report endpoint is public by design (plugins carry no credentials for the dashboard). It validates every field, limits bodies to 8 KB and reports to 60 per minute per IP. Anyone could send invented reports; treat the data as information, not as proof.

## Releasing

Releases are published by `.github/workflows/release.yml` when the version is officially bumped; nobody tags or creates releases by hand.

1. Check that `npm run typecheck && npm test && npm run test:integration` pass.
2. Move the *Unreleased* entries in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` section, and keep an empty *Unreleased* above it.
3. Set the same version in `package.json` (the footer shows it, linked to the release).
4. Push to `main`. The workflow checks that `package.json` matches `CHANGELOG.md`, then tags `vX.Y.Z` and creates the GitHub release (0.x as pre-releases). Railway deploys every push to `main` independently of releases.

## Known limitations / roadmap

- **Plugin Health:** published to the package registries (npm, Packagist, PyPI, NuGet, Maven Central); until then plugins bundle a copy.
- **Callbacks:** the ping only proves reachability. Real callbacks from Supertext will need a signature the plugin can verify (e.g. HMAC with a secret exchanged in the report response) before the plugin acts on them.
- **Fixed outgoing addresses:** for customers whose firewalls only let known addresses in, the dashboard needs a static egress IP (Railway static outbound IPs) published in the plugins' installation guides.
- **Scheduled pings:** today pings follow reports and *Ping now*; a daily ping of all installations would catch sites that went dark without reporting.
- **Remote checks:** a later version answers reports with checks to run (e.g. "test the API key", "translate a sample") and receives their results. The response format already allows extra fields.
- **Authenticity:** reports aren't signed. If invented reports become a problem, plugins could sign with a key derived from the Supertext API key.
- No audit log of who changed a mapping or a note.
- The rate limit and the release cache live in memory: fine for one instance, not for several.
