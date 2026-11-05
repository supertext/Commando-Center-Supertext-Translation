"""Version reports to the Supertext Plugin Health dashboard, the API key check result and the ping endpoint.

Behaviour: ../spec/reporter.json (protocol: the dashboard's docs/DEVELOPER.md → Report protocol).
The reporter is stateless: the plugin loads its :class:`ReporterState` (stored as JSON, see
:meth:`ReporterState.to_json` and :func:`reporter_state`), passes it in, and stores the state it gets
back. It never talks to Supertext itself: the plugin passes a :class:`KeyChecker` built on the
Supertext SDK. Nothing here ever raises: the center is optional.
"""

from __future__ import annotations

import json
import os
import platform
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Final, Literal, Union

from .key_check import KeyCheck, KeyChecker, iso_seconds, parse_iso
from .transport import HttpRequest, Transport, UrllibTransport
from .version import PLUGIN_HEALTH_VERSION

__all__ = [
    "DEFAULT_REPORT_URL",
    "FAILURE_BACKOFF",
    "REPORT_TIMEOUT",
    "InstallationReporter",
    "NameVersion",
    "PingResponse",
    "ReportEvent",
    "ReporterResult",
    "ReporterState",
    "StateInput",
    "ping_response",
    "reporter_state",
    "reports_enabled",
]

DEFAULT_REPORT_URL: Final = "https://commandocenter-production.up.railway.app/api/v1/report"
REPORT_TIMEOUT: Final = 3.0
"""Seconds a report may take."""
FAILURE_BACKOFF: Final = 3600.0
"""Seconds without a new report after a failed one (except :meth:`InstallationReporter.report_check`)."""

StateInput = Union["ReporterState", Mapping[str, Any], str, bytes, None]
"""A state as the plugin stored it: a :class:`ReporterState`, its ``to_dict()``, its JSON, or ``None``."""

ReportEvent = Literal["installed", "settings_saved", "upgraded", "api_key_check", "check"]

_CHALLENGE = re.compile(r"[A-Za-z0-9_-]{16,64}")
_OFF: Final = ("0", "false", "off", "no")
_ON: Final = ("1", "true", "on", "yes")
_PING_HEADERS: Final = {"Content-Type": "application/json", "Cache-Control": "no-store"}


@dataclass(frozen=True)
class NameVersion:
    name: str
    version: str | None = None


@dataclass(frozen=True)
class ReporterState:
    """What the plugin stores between requests.

    Store ``to_json()`` (or ``to_dict()``) as it is and read it back with :func:`reporter_state`. The
    camelCase shape (``reportedVersions``, ``reportedKeyStatus``, ``lastFailureAt``, ``keyCheck``) is the
    same in every language and the same the Supertext SDK 0.1 to 0.2 reporter stored.
    """

    reported_versions: str | None = None
    """``<plugin>|<system>|<runtime>`` versions last reported successfully."""
    reported_key_status: str | None = None
    """The key status last reported successfully."""
    last_failure_at: str | None = None
    """When the last report failed (no new attempt for an hour)."""
    key_check: KeyCheck | None = None
    """The latest key check."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "reportedVersions": self.reported_versions,
            "reportedKeyStatus": self.reported_key_status,
            "lastFailureAt": self.last_failure_at,
            "keyCheck": self.key_check.to_dict() if self.key_check else None,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(",", ":"))


@dataclass(frozen=True)
class ReporterResult:
    state: ReporterState
    """Store this."""
    check: KeyCheck | None
    """The latest key check (show it on the settings or status page)."""
    event: ReportEvent | None
    """The event that was reported (or tried); ``None`` when nothing was due."""
    sent: bool
    """Whether the center accepted the report."""


@dataclass(frozen=True)
class PingResponse:
    status: int
    """200, 400 (bad or missing challenge) or 404 (reporting is off)."""
    headers: Mapping[str, str] = field(default_factory=dict)
    body: str = ""


def reporter_state(value: object) -> ReporterState:
    """A stored state (JSON text, a dict, ``None`` or anything) as a :class:`ReporterState`.

    Unknown or broken values become empty, so a damaged setting never breaks the plugin.
    """
    if isinstance(value, ReporterState):
        return value
    if isinstance(value, (str, bytes)):
        try:
            value = json.loads(value)
        except ValueError:
            value = None
    data: Mapping[str, Any] = value if isinstance(value, Mapping) else {}

    def text(name: str) -> str | None:
        item = data.get(name)
        return item if isinstance(item, str) else None

    raw_check = data.get("keyCheck")
    key_check = KeyCheck.from_value(raw_check) if isinstance(raw_check, Mapping) else None
    return ReporterState(text("reportedVersions"), text("reportedKeyStatus"), text("lastFailureAt"), key_check)


class _FromEnvironment:
    def __repr__(self) -> str:
        return "<SUPERTEXT_VERSION_REPORTS>"


_FROM_ENVIRONMENT: Final = _FromEnvironment()


def reports_enabled(setting: bool | None = None, env: str | _FromEnvironment | None = _FROM_ENVIRONMENT) -> bool:
    """Whether version reports are on.

    ``SUPERTEXT_VERSION_REPORTS`` (0/false/off/no, 1/true/on/yes) wins over the setting
    ("Send version information to Supertext"), which defaults to on. ``env`` defaults to the
    environment variable; pass ``None`` for "not set".
    """
    raw = os.environ.get("SUPERTEXT_VERSION_REPORTS") if isinstance(env, _FromEnvironment) else env
    value = (raw or "").strip().lower()
    if value in _OFF:
        return False
    if value in _ON:
        return True
    return True if setting is None else setting


def ping_response(challenge: str | None, plugin: str, enabled: bool) -> PingResponse:
    """The answer of the plugin's public ping endpoint (``GET <callback>?challenge=<c>``).

    Only while reporting is on (else 404). The challenge is echoed only if it matches
    ``^[A-Za-z0-9_-]{16,64}$`` (else 400). Answer with ``status``, ``headers`` and ``body`` as they are.
    """
    if not enabled:
        return PingResponse(404, dict(_PING_HEADERS), '{"ok":false}')
    if not isinstance(challenge, str) or not _CHALLENGE.fullmatch(challenge):
        return PingResponse(400, dict(_PING_HEADERS), '{"ok":false}')
    body = json.dumps({"ok": True, "plugin": plugin, "challenge": challenge}, separators=(",", ":"))
    return PingResponse(200, dict(_PING_HEADERS), body)


class InstallationReporter:
    """Reports versions and the API key status to the Supertext Plugin Health dashboard.

    ``plugin.name`` is the plugin's GitHub repository name, ``plugin.version`` comes from its official
    version source; ``system`` is the CMS, PIM, shop or application in its own spelling. ``key_checker``
    is the bundled SDK's key check (see :class:`KeyChecker`), ``sdk_version`` the SDK's ``SDK_VERSION``
    (``None``: no ``sdk_version`` in the report). ``callback_url`` is the plugin's public ping endpoint
    (``None`` for hosted apps). ``transport`` sends the report; ``now`` is the Unix time in seconds.
    None of the methods ever raises.
    """

    def __init__(
        self,
        *,
        enabled: bool,
        site_url: str,
        plugin: NameVersion,
        system: NameVersion,
        key_checker: KeyChecker,
        sdk_version: str | None = None,
        runtime: NameVersion | None = None,
        callback_url: str | None = None,
        report_url: str | None = None,
        transport: Transport | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._enabled = enabled
        self.site_url = site_url
        self.plugin = plugin
        self.system = system
        self.key_checker = key_checker
        self.sdk_version = sdk_version
        self.runtime = runtime or NameVersion("Python", platform.python_version())
        self.callback_url = callback_url
        self.report_url = report_url or os.environ.get("SUPERTEXT_REPORT_URL") or DEFAULT_REPORT_URL
        self._transport: Transport = transport or UrllibTransport()
        self._now = now

    def __repr__(self) -> str:
        return f"InstallationReporter(plugin={self.plugin.name!r}, report_url={self.report_url!r})"

    @property
    def enabled(self) -> bool:
        """Whether reports are sent (the ping endpoint answers only then)."""
        return self._enabled

    @property
    def versions(self) -> str:
        """``<plugin>|<system>|<runtime>`` versions (missing parts empty)."""
        return "|".join([self.plugin.version or "", self.system.version or "", self.runtime.version or ""])

    # -- Actions -----------------------------------------------------------------------------

    def after_settings_saved(self, state: StateInput, api_key: str | None) -> ReporterResult:
        """After the plugin's settings were saved: checks the key, reports ``installed`` or ``settings_saved``."""
        current = replace(reporter_state(state), key_check=self._check(api_key))
        return self._report_if_due(current, "installed" if current.reported_versions is None else "settings_saved")

    def on_request(self, state: StateInput, api_key: str | None) -> ReporterResult:
        """On back-end requests that run the plugin's code: checks a changed key, reports what changed."""
        current = reporter_state(state)
        if current.key_check is None or current.key_check.fingerprint != self._fingerprint(api_key):
            current = replace(current, key_check=self._check(api_key))
        return self._report_if_due(current, self._due_event(current))

    def authentication_failed(self, state: StateInput, api_key: str | None, http_status: int = 401) -> ReporterResult:
        """A translation was rejected with 401/403: the key is invalid (no check against Supertext)."""
        check = KeyCheck("invalid", iso_seconds(self._now()), http_status, None, self._fingerprint(api_key))
        current = replace(reporter_state(state), key_check=check)
        return self._report_if_due(current, self._due_event(current))

    def test_connection(self, state: StateInput, api_key: str | None) -> ReporterResult:
        """The "Test connection" button: checks the key, reports a change."""
        current = replace(reporter_state(state), key_check=self._check(api_key))
        return self._report_if_due(current, self._due_event(current))

    def report_check(self, state: StateInput) -> ReporterResult:
        """Sends a ``check`` report now (commands, tests), even after a recent failure."""
        return self._send(reporter_state(state), "check")

    def build_report(self, event: ReportEvent, state: StateInput) -> dict[str, Any]:
        """The report body for an event and state (neither the key nor its fingerprint is part of it)."""
        current = reporter_state(state)
        body: dict[str, Any] = {
            "schema": 1,
            "event": event,
            "site_url": self.site_url,
            "plugin": {"name": self.plugin.name, "version": self.plugin.version or ""},
            "system": _name_version(self.system),
            "runtime": _name_version(self.runtime),
        }
        if self.sdk_version:
            body["sdk_version"] = self.sdk_version
        check = current.key_check
        if check is not None:
            body["api_key_configured"] = check.fingerprint != ""
            entry: dict[str, Any] = {"status": check.status, "checked_at": check.checked_at}
            if check.http_status is not None:
                entry["http_status"] = check.http_status
            if check.error_code is not None:
                entry["error_code"] = check.error_code
            body["api_key_check"] = entry
        if self.callback_url:
            body["callback"] = {"url": self.callback_url}
        return body

    # -- Internals ---------------------------------------------------------------------------

    def _due_event(self, state: ReporterState) -> ReportEvent | None:
        if state.reported_versions is None:
            return "installed"
        if state.reported_versions != self.versions:
            return "upgraded"
        if state.key_check is not None and state.key_check.status != state.reported_key_status:
            return "api_key_check"
        return None

    def _fingerprint(self, api_key: str | None) -> str:
        try:
            fingerprint = self.key_checker.fingerprint(api_key or "")
        except Exception:  # the SDK's never raises; a plugin's own might
            return ""
        return fingerprint if isinstance(fingerprint, str) else ""

    def _check(self, api_key: str | None) -> KeyCheck:
        try:
            check = KeyCheck.from_value(self.key_checker.check(api_key or ""))
            if check is not None:
                return check
        except Exception:  # the SDK's check never raises; a plugin's own checker might
            pass
        return KeyCheck("error", iso_seconds(self._now()), None, None, self._fingerprint(api_key))

    def _report_if_due(self, state: ReporterState, event: ReportEvent | None) -> ReporterResult:
        if event is None or not self._enabled:
            return ReporterResult(state, state.key_check, None, False)
        if state.last_failure_at is not None:
            failed = parse_iso(state.last_failure_at)
            if failed is not None and self._now() - failed < FAILURE_BACKOFF:
                return ReporterResult(state, state.key_check, None, False)
        return self._send(state, event)

    def _send(self, state: ReporterState, event: ReportEvent) -> ReporterResult:
        if not self._enabled:
            return ReporterResult(state, state.key_check, None, False)
        ok = False
        try:
            body = json.dumps(self.build_report(event, state), separators=(",", ":")).encode("utf-8")
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": (
                    f"supertext-plugin-health/{PLUGIN_HEALTH_VERSION} (python) "
                    f"{self.plugin.name}/{self.plugin.version or ''}"
                ),
            }
            response = self._transport(HttpRequest("POST", self.report_url, headers, body, REPORT_TIMEOUT))
            ok = 200 <= response.status < 300
        except Exception:
            ok = False  # never fails the caller: the center is optional
        if ok:
            key_status = state.key_check.status if state.key_check else state.reported_key_status
            next_state = replace(
                state, reported_versions=self.versions, reported_key_status=key_status, last_failure_at=None
            )
        else:
            next_state = replace(state, last_failure_at=iso_seconds(self._now()))
        return ReporterResult(next_state, next_state.key_check, event, ok)


def _name_version(value: NameVersion) -> dict[str, str]:
    return {"name": value.name, "version": value.version} if value.version else {"name": value.name}
