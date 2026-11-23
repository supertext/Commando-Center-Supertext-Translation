# Changelog — Supertext Plugin Health

All five languages share one version. Changes not yet released go under *Unreleased*.

## Unreleased

## 0.4.0 — 2026-11-09

### Added

- Language mapping: `sendLanguages(state, list)` (PHP `sendLanguages`, Python `send_languages`, .NET `SendLanguagesAsync`, Java `sendLanguages`) sends each language configured in the system with the Supertext code it maps to (`code`, `supertext`, `null` when not mapped) with the new event `languages`, for the plugin's *Send language settings to Supertext* button: now, even after a recent failure, but only while reporting is on. Optional `languages` function in the options: every report then carries the mapping. Codes trimmed and cut to 35 characters, blank codes and repeats dropped, at most 100 (`MAX_LANGUAGES`, `normalizeLanguages`). New types: TypeScript `LanguageMapping`, .NET and Java `LanguageMapping` records, Python `LanguageMapping` (a mapping). `buildReport` takes the mapping as an optional last argument. Spec: three scenarios in `spec/reporter.json`. Needs the dashboard with migration 006 (older dashboards store the report and ignore the mapping).

## 0.3.0 — 2026-11-08

### Added

- Installed plugins: `sendExtensions(state, list)` (PHP `sendExtensions`, Python `send_extensions`, .NET `SendExtensionsAsync`, Java `sendExtensions`) sends the other plugins, extensions, modules or themes installed on the site (`name`, `version`, `active`, `type`) with the new event `extensions`, for the plugin's *Send installed plugins to Supertext* button: now, even after a recent failure, but only while reporting is on. Optional `extensions` function in the options: every report then carries the list (the developer's choice; by default the list is only sent by hand). The list is trimmed and cut, types in lower case, blank names and repeats dropped, at most 500 (`MAX_EXTENSIONS`, `normalizeExtensions`). New types: TypeScript `Extension`, .NET `Extension` record, Java `Extension` record, Python `Extension` (a mapping). Spec: three scenarios in `spec/reporter.json`. Needs the dashboard with migration 005 (older dashboards store the report and ignore the list).

## 0.2.0 — 2026-11-07

### Added

- Several named API keys: every action takes one key as before or several by name (at most 20). Each key is checked when it changes and reported in the new report field `api_keys` (`[{name, configured, check}]`); `api_key_check` goes out when any key's status changes; `authenticationFailed` takes the name of the rejected key. New state fields `keyChecks` and `reportedKeyStatuses` (null with one key; states stored by 0.1 load unchanged), new result field `checks`, `MAX_API_KEYS`. Spec: three scenarios in `spec/reporter.json`.
- `config.json`: the default report URL lives only in `plugin-health/config.json`; each language reads its bundled copy (`scripts/sync-config.sh`, checked in CI).

### Changed

- Default report URL: `https://pluginhealth.supertext.com/api/v1/report` (the dashboard's own domain; the Railway address keeps working for plugins on 0.1).
- PHP: `InstallationReporter::DEFAULT_REPORT_URL` is now `InstallationReporter::defaultReportUrl()`; .NET: `Reporting.DefaultReportUrl` is a `static readonly` field instead of a `const`.
- Bundling: the copy must include `config.json` (see README → *Bundling it in a plugin*).

## 0.1.0 — 2026-10-16

### Added

- TypeScript, PHP, Python, .NET and Java: `InstallationReporter` (version reports, the API key check result, `installed`/`settings_saved`/`upgraded`/`api_key_check`/`check`), `reportsEnabled()` (setting plus `SUPERTEXT_VERSION_REPORTS`), `pingResponse()` for the plugin's public ping endpoint, `ReporterState` and `KeyCheck`.
- Moved here from the Supertext SDK (0.1–0.2), with one change: the reporter no longer creates an SDK client. The plugin passes a key checker (the SDK's `checkApiKey()` and `apiKeyFingerprint()`) and the SDK version. The stored state is unchanged.
- `spec/reporter.json`: the reporter's scenarios, the setting and the ping answers.
