# Supertext Plugin Health — PHP

The PHP version of [Supertext Plugin Health](../README.md): version reports to the Supertext Plugin Health dashboard, the result of the plugin's API key check, and the answer of its ping endpoint. Namespace `Supertext\PluginHealth`, Composer package `supertext/plugin-health`.

- PHP 8.1 or newer, no dependencies (ext-json; ext-curl only for the built-in `CurlTransport`, not when the plugin passes its own `Http\HttpTransport`).
- Plugins bundle a copy of `src/` (renamed into the plugin's namespace) with `scripts/vendor-plugin-health.sh`; see the [main README](../README.md#bundling-it-in-a-plugin). The version is `PluginHealth::PLUGIN_HEALTH_VERSION`, shared with the other languages.

## Usage

```php
use Supertext\PluginHealth\CallableKeyChecker;
use Supertext\PluginHealth\InstallationReporter;
use Supertext\PluginHealth\ReporterState;

$reporter = new InstallationReporter(
    enabled: InstallationReporter::reportsEnabled($settings->versionReports), // null = not set (on)
    siteUrl: 'https://www.example.ch',
    pluginName: 'Contao-Supertext-Translation',
    pluginVersion: PLUGIN_VERSION,
    systemName: 'Contao',
    systemVersion: $contaoVersion,
    sdkVersion: Supertext::SDK_VERSION,                    // the bundled SDK; null without it
    callbackUrl: 'https://www.example.ch/supertext/ping',  // null for hosted apps
    keyChecker: new CallableKeyChecker(
        static fn (string $key) => (new Client($key))->checkApiKey(),
        [Protocol::class, 'apiKeyFingerprint'],
    ),
);

$result = $reporter->afterSettingsSaved(ReporterState::fromJson($stored), $apiKey);
store($result->state->toJson());   // show $result->check to the admin

// onRequest($state, $key), authenticationFailed($state, $key, 401), testConnection($state, $key), reportCheck($state)

$ping = InstallationReporter::pingResponse($_GET['challenge'] ?? null, 'Contao-Supertext-Translation', $reporter->enabled());
// answer with $ping->status, $ping->headers and $ping->body as they are
```

`KeyCheck::from()` accepts the SDK's `ApiKeyCheck` (any object with its public properties) or an array; a checker that throws or returns something else gives status `error`. `ReporterState` reads states stored by the Supertext SDK 0.1–0.2 reporter. Other options: `runtimeName`/`runtimeVersion` (default `PHP`, `PHP_VERSION`), `reportUrl` (default `SUPERTEXT_REPORT_URL`, else the live center), `transport`, `now`.

## Tests

```sh
composer install
vendor/bin/phpunit
vendor/bin/phpstan analyse
```

The tests run `../spec/reporter.json` and the dashboard's `../../spec/` (ping cases, report schema), and check that the version matches `../typescript/package.json`.
