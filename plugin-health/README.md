# Supertext Plugin Health

The plugin side of the [Supertext Plugin Health dashboard](../README.md): every Supertext plugin uses it to

- **report its versions** (plugin, CMS/shop/PIM, runtime, bundled SDK) when its settings are saved and after an update,
- **report the result of its API key check** (the check itself is the Supertext SDK's `checkApiKey()`),
- **answer the dashboard's reachability ping** on a public endpoint.

It lives next to the dashboard because the protocol, the server and the client change together. It has no runtime dependencies and doesn't need the Supertext SDK: the plugin passes the SDK's key check in.

| Language | Folder | Package / namespace | Needs |
| --- | --- | --- | --- |
| TypeScript | [`typescript/`](typescript/) | `supertext-plugin-health` | Node.js 18+ (Deno, Bun) |
| PHP | [`php/`](php/) | `Supertext\PluginHealth` (`supertext/plugin-health`) | PHP 8.1+; ext-curl only for the built-in transport |
| Python | [`python/`](python/) | `supertext_plugin_health` (`supertext-plugin-health`) | Python 3.10+ |
| .NET | [`dotnet/`](dotnet/) | `Supertext.PluginHealth` | .NET 8 |
| Java | [`java/`](java/) | `com.supertext.pluginhealth` (`com.supertext:supertext-plugin-health`) | Java 17+ |

All five share one version (`CHANGELOG.md` here) and pass the same vectors: [`spec/reporter.json`](spec/reporter.json) plus the dashboard's [`spec/`](../spec/) (report schema and examples, ping cases). The protocol is in the dashboard's [developer guide → Report protocol](../docs/DEVELOPER.md#report-protocol).

## What a plugin does

Same concepts in every language, named the way the language expects (TypeScript shown):

```ts
import { SupertextClient, apiKeyFingerprint, SDK_VERSION } from 'supertext-sdk' // the bundled SDK
import { InstallationReporter, reportsEnabled, reporterState, pingResponse } from 'supertext-plugin-health'

const reporter = new InstallationReporter({
  enabled: reportsEnabled(settings.versionReports),       // setting (default on) + SUPERTEXT_VERSION_REPORTS
  siteUrl: 'https://www.example.ch',                       // the site's base URL as the system knows it
  plugin: { name: 'Directus-Supertext-Translation', version: PLUGIN_VERSION },
  system: { name: 'Directus', version: directusVersion },
  sdkVersion: SDK_VERSION,
  callbackUrl: 'https://www.example.ch/supertext/ping',    // null for hosted apps
  keyChecker: { check: (key) => new SupertextClient(key).checkApiKey(), fingerprint: apiKeyFingerprint },
})

// Settings saved → check the key, report installed/settings_saved, show result.check to the admin.
const r = await reporter.afterSettingsSaved(reporterState(stored), apiKey)
store(r.state)

// Back-end requests that run the plugin anyway: reports upgrades and changed keys.
store((await reporter.onRequest(reporterState(stored), apiKey)).state)
// A translation got 401/403:        reporter.authenticationFailed(state, apiKey, 401)
// The "Test connection" button:     reporter.testConnection(state, apiKey)
// A check command:                  reporter.reportCheck(state)

// Several Supertext API keys (e.g. AI translation and professional orders): pass them by name, in the order
// the settings show them, instead of one key. Each is checked and reported in api_keys.
const keys = { 'AI translation': aiKey, 'Professional orders': ordersKey }
store((await reporter.afterSettingsSaved(reporterState(stored), keys)).state)
// A translation with the orders key got 401/403:
// reporter.authenticationFailed(state, keys, 401, 'Professional orders')

// The public ping endpoint (GET, no login, not cached):
const p = pingResponse(query.challenge, { plugin: 'Directus-Supertext-Translation', enabled: reporter.enabled })
// → answer with p.status, p.headers and p.body as they are
```

- `InstallationReporter` methods: `afterSettingsSaved`, `onRequest`, `authenticationFailed`, `testConnection`, `reportCheck`, `buildReport`, plus `enabled` and `versions`. They never throw and never take longer than the report timeout (3 s) plus the key check.
- `ReporterState` is a small JSON object (`reportedVersions`, `reportedKeyStatus`, `lastFailureAt`, `keyCheck`, and for several keys `keyChecks` and `reportedKeyStatuses`, by name) the plugin stores as it is. The first four are the state the Supertext SDK 0.1–0.2 reporter stored, so a plugin that switches keeps its history: no new `installed` report.
- **Several keys** (0.2.0): every action takes either one key (a string; reported as `api_key_configured` and `api_key_check`) or several by name (at most 20; reported as `api_keys`, see the dashboard's *Report protocol*): TypeScript and Python an object/mapping, PHP an array, .NET `IEnumerable<KeyValuePair<string, string>>` (e.g. a `Dictionary`), Java a `Map` (use a `LinkedHashMap` to keep the order). Changed keys are checked on the next request; an `api_key_check` report goes out when any key's status changes; `authenticationFailed` takes the name of the key that was rejected. The result's `checks` (`Checks`, `getChecks()`) has each key's check; `check` is null then. Names are what the settings call the keys (60 characters at most), never the keys themselves. In .NET and Java, passing a `null` literal as the key is ambiguous between the two overloads: pass a `string?`/`String` variable.
- `KeyCheck` has the fields of the SDK's `ApiKeyCheck` (`status`, `checkedAt`, `httpStatus`, `errorCode`, `fingerprint`). TypeScript, PHP (`KeyCheck::from()`) and Python (`KeyCheck.from_value()`) accept the SDK's object as it is; .NET and Java convert it in one line (`new KeyCheck(c.Status, c.CheckedAt, c.HttpStatus, c.ErrorCode, c.Fingerprint)`).
- Key checker per language: TypeScript `{ check, fingerprint }`, PHP `new CallableKeyChecker($check, $fingerprint)`, Python `CallableKeyChecker(check=..., fingerprint=...)`, .NET `KeyChecker.FromDelegates(check, fingerprint)`, Java `KeyChecker.of(check, fingerprint)`. A checker that throws gives an `error` check; it never reaches the plugin.
- Defaults: report URL from `config.json` (`https://pluginhealth.supertext.com/api/v1/report`; `SUPERTEXT_REPORT_URL` overrides it), 3 s timeout, no new attempt for an hour after a failed report. Reports are fire-and-forget: a failure never reaches the plugin's user.
- **`config.json`** (0.2.0): the default report URL is written only in `plugin-health/config.json`. Every language ships a copy next to its sources and reads it: TypeScript imports `src/config.json` (bundled at build time), PHP reads `src/config.json`, Python `config.json` in the package, .NET the embedded resource `config.json` (name ending in `PluginHealth.config.json`), Java the classpath resource `config.json` in the package. `scripts/sync-config.sh` writes the copies, `scripts/sync-config.sh --check` (CI) makes sure they match. Without the file, reports go nowhere unless `SUPERTEXT_REPORT_URL` is set.
- The API key never leaves the plugin; reports carry only the check's status, time, HTTP status and Supertext's error code.

## Bundling it in a plugin

Plugins ship a copy, like the Supertext SDK: sites install nothing besides the plugin. Each plugin has `scripts/vendor-plugin-health.sh [commit-or-branch]` (default `main`; `PLUGIN_HEALTH_DIR=/path/to/clone` uses a local clone) that clones this repository, copies `plugin-health/<language>/src` (TypeScript: the built `dist/`) into the plugin, renames the namespace into the plugin's own (PHP, Python, .NET, Java), and writes `LICENSE`, `COMMIT`, `VERSION` and a "bundled copy, don't edit" `README.md` next to it. Never edit a copy: fix it here, then re-run the script.

Since 0.2.0 the copy must include `config.json`: TypeScript and PHP get it with `src/`; Python copies `config.json` with the `.py` files; .NET adds it as an embedded resource in the plugin's project (`<EmbeddedResource Include="…/supertext-plugin-health/src/config.json" LogicalName="Supertext.PluginHealth.config.json" />`); Java copies `src/main/resources/com/supertext/pluginhealth/config.json` into the renamed package's resource folder and adds that folder to the build's resources. A plugin's tests should check that `DEFAULT_REPORT_URL` isn't empty.

## Working on it

| Language | Commands (in its folder) |
| --- | --- |
| TypeScript | `npm ci && npm run typecheck && npm test && npm run build` |
| PHP | `composer update && vendor/bin/phpstan analyse && vendor/bin/phpunit` |
| Python | `python -m pip install -e '.[test]' && ruff check . && python -m mypy && python -m pytest` |
| .NET | `dotnet build -warnaserror && dotnet test` |
| Java | `mvn -B verify` |

CI (`.github/workflows/plugin-health.yml`) runs all five on every change to `plugin-health/` or `spec/`. The dashboard's own tests check that every report the TypeScript reference builds is accepted by the dashboard (`test/unit/plugin-health.test.ts`).

A behaviour change starts with `spec/reporter.json`, then all five languages, their tests, this README and `CHANGELOG.md`, in one commit. Releases: a new `## X.Y.Z — YYYY-MM-DD` section in `CHANGELOG.md` with the same version in every language's version file and constant tags `plugin-health-vX.Y.Z` (`.github/workflows/plugin-health-release.yml`).
