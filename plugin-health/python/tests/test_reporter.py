"""../spec/reporter.json and the dashboard's spec (callback-vectors.json, report-v1.schema.json)."""

from __future__ import annotations

import json
import platform
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

import supertext_plugin_health
from supertext_plugin_health import (
    DEFAULT_REPORT_URL,
    FAILURE_BACKOFF,
    PLUGIN_HEALTH_VERSION,
    REPORT_TIMEOUT,
    CallableKeyChecker,
    HttpRequest,
    HttpResponse,
    InstallationReporter,
    KeyCheck,
    KeyChecker,
    NameVersion,
    ReporterResult,
    ReporterState,
    parse_iso,
    ping_response,
    reporter_state,
    reports_enabled,
)

PYTHON_DIR = Path(__file__).resolve().parents[1]
PLUGIN_HEALTH_DIR = PYTHON_DIR.parent
CENTER_SPEC_DIR = PLUGIN_HEALTH_DIR.parent / "spec"


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


S = load(PLUGIN_HEALTH_DIR / "spec" / "reporter.json")
CALLBACK = load(CENTER_SPEC_DIR / "callback-vectors.json")
SCHEMA = load(CENTER_SPEC_DIR / "report-v1.schema.json")
REPORT_URL = "https://center.test/api/v1/report"


@dataclass(frozen=True)
class SdkApiKeyCheck:
    """Stands in for the Supertext SDK's ApiKeyCheck (same attribute names, its own class)."""

    status: str
    checked_at: str
    http_status: int | None
    error_code: str | None
    fingerprint: str


class Fakes:
    """Fake key checker (returns the step's keyCheck) and fake center; records the calls in order."""

    def __init__(self, key_check: dict[str, Any] | None, report: dict[str, Any] | None) -> None:
        self.key_check = key_check
        self.report = report
        self.calls: list[str] = []
        self.requests: list[HttpRequest] = []
        self.bodies: list[Any] = []

    # KeyChecker
    def check(self, api_key: str) -> object:
        self.calls.append("keyCheck")
        if self.key_check is None:
            raise AssertionError("unexpected key check")
        k = self.key_check
        return SdkApiKeyCheck(k["status"], k["checkedAt"], k["httpStatus"], k["errorCode"], k["fingerprint"])

    def fingerprint(self, api_key: str) -> str:
        if api_key not in S["fingerprints"]:
            raise AssertionError(f"no fingerprint for {api_key!r}")
        fingerprint: str = S["fingerprints"][api_key]
        return fingerprint

    # Transport
    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.calls.append("report")
        self.requests.append(request)
        assert request.url == REPORT_URL
        assert request.method == "POST"
        assert request.body is not None
        self.bodies.append(json.loads(request.body))
        if not self.report:
            raise AssertionError("unexpected report")
        if self.report.get("transportError"):
            raise OSError("connection refused")
        return HttpResponse(self.report.get("status", 202))


def epoch(iso: str) -> float:
    seconds = parse_iso(iso)
    assert seconds is not None
    return seconds


def reporter(config: dict[str, Any], fakes: Fakes, now: float = 0.0, **overrides: Any) -> InstallationReporter:
    runtime = config.get("runtime")
    options: dict[str, Any] = {
        "enabled": config["enabled"],
        "site_url": config["siteUrl"],
        "plugin": NameVersion(**config["plugin"]),
        "system": NameVersion(**config["system"]),
        "runtime": NameVersion(**runtime) if runtime else None,
        "sdk_version": config.get("sdkVersion"),
        "callback_url": config.get("callbackUrl"),
        "key_checker": fakes,
        "report_url": REPORT_URL,
        "transport": fakes,
        "now": lambda: now,
        **overrides,
    }
    return InstallationReporter(**options)


# -- Defaults and version ---------------------------------------------------------------------


def test_defaults() -> None:
    assert S["defaults"]["reportUrl"] == DEFAULT_REPORT_URL
    assert S["defaults"]["reportTimeoutSeconds"] == REPORT_TIMEOUT
    assert S["defaults"]["failureBackoffSeconds"] == FAILURE_BACKOFF


def test_version_matches_pyproject_and_typescript() -> None:
    pyproject = (PYTHON_DIR / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version = "([^"]+)"', pyproject, re.MULTILINE)
    assert match
    typescript = load(PLUGIN_HEALTH_DIR / "typescript" / "package.json")["version"]
    assert PLUGIN_HEALTH_VERSION == match.group(1) == typescript == supertext_plugin_health.__version__


def test_package_uses_only_relative_imports() -> None:
    """Plugins copy the package under their own import root."""
    package = PYTHON_DIR / "src" / "supertext_plugin_health"
    for source in package.glob("*.py"):
        assert "supertext_plugin_health" not in source.read_text(encoding="utf-8"), source.name


# -- Enabled and ping -------------------------------------------------------------------------


@pytest.mark.parametrize("case", S["enabled"], ids=lambda c: f"{c['setting']!r} {c['env']!r}")
def test_enabled(case: dict[str, Any]) -> None:
    assert reports_enabled(case["setting"], case["env"]) is case["out"]


def test_enabled_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPERTEXT_VERSION_REPORTS", "off")
    assert reports_enabled(True) is False
    monkeypatch.delenv("SUPERTEXT_VERSION_REPORTS")
    assert reports_enabled() is True
    assert reports_enabled(False) is False


@pytest.mark.parametrize("case", S["ping"]["cases"], ids=lambda c: f"{c['challenge']!r} enabled={c['enabled']}")
def test_ping(case: dict[str, Any]) -> None:
    response = ping_response(case["challenge"], S["ping"]["plugin"], case["enabled"])
    assert response.status == case["status"]
    assert json.loads(response.body) == case["body"]
    assert dict(response.headers) == {"Content-Type": "application/json", "Cache-Control": "no-store"}


@pytest.mark.parametrize("case", CALLBACK["endpoint"]["cases"], ids=lambda c: repr(c["challenge"]))
def test_ping_center_vectors(case: dict[str, Any]) -> None:
    response = ping_response(case["challenge"], "Some-Supertext-Translation", True)
    assert response.status == case["status"]
    expected = dict(case["body"])
    if "plugin" in expected:
        expected["plugin"] = "Some-Supertext-Translation"
    assert json.loads(response.body) == expected


# -- The reporter's state machine -------------------------------------------------------------


def run(r: InstallationReporter, step: dict[str, Any], state: ReporterState) -> ReporterResult:
    action = step["action"]
    if action == "afterSettingsSaved":
        return r.after_settings_saved(state, step["apiKey"])
    if action == "onRequest":
        return r.on_request(state, step["apiKey"])
    if action == "authenticationFailed":
        return r.authentication_failed(state, step["apiKey"], step["httpStatus"])
    if action == "testConnection":
        return r.test_connection(state, step["apiKey"])
    assert action == "reportCheck"
    return r.report_check(state)


@pytest.mark.parametrize("scenario", S["scenarios"], ids=lambda s: s["name"])
def test_scenario(scenario: dict[str, Any]) -> None:
    config = {**S["config"], **scenario.get("config", {})}
    state = reporter_state(json.loads(json.dumps(scenario["state"])))
    for step in scenario["steps"]:
        fakes = Fakes(step.get("keyCheck"), step.get("report"))
        result = run(reporter(config, fakes, epoch(step["now"])), step, state)
        expect = step["expect"]
        assert fakes.calls == expect["calls"], step["action"]
        assert result.event == expect["event"]
        assert result.sent is expect["sent"]
        assert (result.check.to_dict() if result.check else None) == expect["check"]
        assert result.state.to_dict() == expect["state"]
        if "reportBody" in expect:
            assert fakes.bodies[0] == expect["reportBody"]
        for request in fakes.requests:
            assert request.timeout == REPORT_TIMEOUT
            assert request.headers["User-Agent"] == (
                f"supertext-plugin-health/{PLUGIN_HEALTH_VERSION} (python) "
                f"{config['plugin']['name']}/{config['plugin']['version']}"
            )
        # The stored form survives a JSON round trip.
        state = reporter_state(result.state.to_json())
        assert state.to_dict() == expect["state"]
        assert json.loads(result.state.to_json()) == expect["state"]


def test_report_fields_match_the_center_schema() -> None:
    body = reporter(S["config"], Fakes(None, None)).build_report("settings_saved", None)
    for name in SCHEMA["required"]:
        assert name in body
    for name in body:
        assert name in SCHEMA["properties"]
    with_check = ReporterState(key_check=KeyCheck("invalid", "2026-10-13T08:00:00Z", 401, "INVALID_API_KEY", "ab"))
    for name in reporter(S["config"], Fakes(None, None)).build_report("check", with_check):
        assert name in SCHEMA["properties"]


# -- Reporter details -------------------------------------------------------------------------


OK = KeyCheck("ok", "2026-10-13T08:00:00Z", 200, None, "fp-abc")


def test_never_sends_the_key_or_fingerprint() -> None:
    fakes = Fakes(None, {"status": 202})
    checker = CallableKeyChecker(check=lambda _key: OK, fingerprint=lambda _key: "fp-abc")
    r = reporter(S["config"], fakes, epoch("2026-10-13T08:00:00Z"), key_checker=checker)
    result = r.after_settings_saved(None, "secret-key-123")
    assert result.sent
    sent = json.dumps(fakes.bodies) + repr([dict(q.headers) for q in fakes.requests])
    assert "secret-key-123" not in sent
    assert "fp-abc" not in sent
    assert "secret-key-123" not in repr(r) + repr(result) + result.state.to_json()


def test_checker_that_raises_gives_an_error_check() -> None:
    def boom(_key: str) -> object:
        raise RuntimeError("boom")

    checker = CallableKeyChecker(check=boom, fingerprint=lambda _key: "fp")
    r = reporter(
        S["config"], Fakes(None, None), epoch("2026-10-13T08:00:00Z") + 0.7, key_checker=checker, enabled=False
    )
    result = r.after_settings_saved(None, "k")
    assert result.check == KeyCheck("error", "2026-10-13T08:00:00Z", None, None, "fp")


def test_checker_that_returns_garbage_gives_an_error_check() -> None:
    checker = CallableKeyChecker(check=lambda _key: {"status": "ok"}, fingerprint=lambda _key: "fp")
    r = reporter(S["config"], Fakes(None, None), epoch("2026-10-13T08:00:00Z"), key_checker=checker, enabled=False)
    assert r.test_connection(None, "k").check == KeyCheck("error", "2026-10-13T08:00:00Z", None, None, "fp")


def test_fingerprint_that_raises_never_reaches_the_caller() -> None:
    def boom(_key: str) -> str:
        raise RuntimeError("boom")

    checker = CallableKeyChecker(check=lambda _key: OK, fingerprint=boom)
    r = reporter(S["config"], Fakes(None, None), epoch("2026-10-13T08:00:00Z"), key_checker=checker, enabled=False)
    result = r.authentication_failed(None, "k")
    assert result.check == KeyCheck("invalid", "2026-10-13T08:00:00Z", 401, None, "")


def test_unexpected_transport_errors_never_reach_the_caller() -> None:
    def transport(request: HttpRequest) -> HttpResponse:
        raise RuntimeError("boom")

    checker = CallableKeyChecker(check=lambda _key: OK, fingerprint=lambda _key: "fp-abc")
    r = reporter(
        S["config"], Fakes(None, None), epoch("2026-10-13T08:00:00Z"), key_checker=checker, transport=transport
    )
    result = r.after_settings_saved(None, "k1")
    assert result.event == "installed" and not result.sent
    assert result.state.last_failure_at == "2026-10-13T08:00:00Z"


def test_key_check_from_value_variants() -> None:
    sdk = SdkApiKeyCheck("ok", "2026-10-13T08:00:00Z", 200, None, "fp-abc")
    assert KeyCheck.from_value(OK) is OK
    assert KeyCheck.from_value(sdk) == OK
    assert KeyCheck.from_value(OK.to_dict()) == OK
    snake = {"status": "ok", "checked_at": "2026-10-13T08:00:00Z", "http_status": 200, "fingerprint": "fp-abc"}
    assert KeyCheck.from_value(snake) == OK
    assert KeyCheck.from_value({**OK.to_dict(), "extra": 1, "httpStatus": True}) == KeyCheck(
        "ok", "2026-10-13T08:00:00Z", None, None, "fp-abc"
    )
    assert KeyCheck.from_value({"status": "ok"}) is None
    assert KeyCheck.from_value(None) is None
    assert KeyCheck.from_value("ok") is None
    assert KeyCheck.from_value(42) is None


def test_callable_key_checker_is_a_key_checker() -> None:
    checker: KeyChecker = CallableKeyChecker(check=lambda key: key, fingerprint=lambda key: key.upper())
    assert checker.check("a") == "a"
    assert checker.fingerprint("a") == "A"


def test_no_sdk_version_without_one() -> None:
    config = {**S["config"], "sdkVersion": None}
    body = reporter(config, Fakes(None, None)).build_report("check", None)
    assert "sdk_version" not in body


def test_properties() -> None:
    r = reporter(S["config"], Fakes(None, None))
    assert r.enabled is True
    assert r.versions == "0.2.0|12.0.0|22.11.0"
    assert reporter({**S["config"], "enabled": False}, Fakes(None, None)).enabled is False


def test_report_url_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    checker = CallableKeyChecker(check=lambda _key: OK, fingerprint=lambda _key: "")
    plugin, system = NameVersion("X", "1"), NameVersion("Y")
    monkeypatch.setenv("SUPERTEXT_REPORT_URL", "https://other.test/report")
    r = InstallationReporter(enabled=True, site_url="s", plugin=plugin, system=system, key_checker=checker)
    assert r.report_url == "https://other.test/report"
    monkeypatch.delenv("SUPERTEXT_REPORT_URL")
    r = InstallationReporter(enabled=True, site_url="s", plugin=plugin, system=system, key_checker=checker)
    assert r.report_url == DEFAULT_REPORT_URL


def test_broken_stored_state_is_empty() -> None:
    empty = ReporterState()
    assert reporter_state("not json") == empty
    assert reporter_state(b"\xff") == empty
    assert reporter_state(None) == empty
    assert reporter_state([1, 2]) == empty
    assert reporter_state({"reportedVersions": 3, "keyCheck": {"status": "ok"}}) == empty
    assert reporter_state(empty.to_dict()) == empty
    assert reporter_state(empty.to_json()) == empty


def test_reads_a_state_stored_by_the_sdk_reporter() -> None:
    old = (
        '{"reportedVersions":"0.2.0|12.0.0|22.11.0","reportedKeyStatus":"ok","lastFailureAt":null,'
        '"keyCheck":{"status":"ok","checkedAt":"2026-10-13T08:00:00Z","httpStatus":200,"errorCode":null,'
        '"fingerprint":"fp-abc"}}'
    )
    state = reporter_state(old)
    assert state == ReporterState("0.2.0|12.0.0|22.11.0", "ok", None, OK)
    assert json.loads(state.to_json()) == json.loads(old)


def test_detects_the_runtime() -> None:
    config = {**S["config"], "runtime": None}
    body = reporter(config, Fakes(None, None)).build_report("check", None)
    assert body["runtime"] == {"name": "Python", "version": platform.python_version()}
