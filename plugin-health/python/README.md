# Supertext Plugin Health (Python)

Version reports, the API key check result and the reachability ping of Supertext plugins, for the [Supertext Plugin Health dashboard](https://github.com/Supertext/Commando-Center-Supertext-Translation). No dependencies; Python 3.10+. Import package `supertext_plugin_health`, distribution `supertext-plugin-health`.

Usage, concepts and bundling: [Plugin Health README](../README.md). The behaviour follows the TypeScript reference (`../typescript/src/index.ts`) and `../spec/reporter.json`.

```python
from my_plugin._vendor.plugin_health import (
    CallableKeyChecker,
    InstallationReporter,
    NameVersion,
    ping_response,
    reporter_state,
    reports_enabled,
)
from my_plugin._vendor.supertext import SDK_VERSION, SupertextClient, api_key_fingerprint  # the bundled SDK

reporter = InstallationReporter(
    enabled=reports_enabled(settings.version_reports),
    site_url="https://www.example.ch",
    plugin=NameVersion("Wagtail-Supertext-Translation", PLUGIN_VERSION),
    system=NameVersion("Wagtail", wagtail.__version__),
    sdk_version=SDK_VERSION,
    callback_url="https://www.example.ch/supertext/ping",  # None for hosted apps
    key_checker=CallableKeyChecker(
        check=lambda key: SupertextClient(key).check_api_key(), fingerprint=api_key_fingerprint
    ),
)
result = reporter.after_settings_saved(reporter_state(stored), api_key)
store(result.state.to_json())
```

Inside the package only relative imports are used, so a plugin can copy `src/supertext_plugin_health/` under its own import root.

## Working on it

```bash
python3 -m venv .venv && . .venv/bin/activate
python -m pip install -e '.[test]'
python -m pytest && python -m mypy && python -m ruff check . && python -m ruff format --check .
```

The tests read `../spec/reporter.json`, the dashboard's `../../spec/` (ping cases, report schema) and `../typescript/package.json` (same version).
