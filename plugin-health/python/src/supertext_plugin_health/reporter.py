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
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Final, Literal, Union

from .key_check import KeyCheck, KeyChecker, iso_seconds, parse_iso
from .transport import HttpRequest, Transport, UrllibTransport
from .version import PLUGIN_HEALTH_VERSION

__all__ = [
    "DEFAULT_REPORT_URL",
    "FAILURE_BACKOFF",
    "MAX_API_KEYS",
    "MAX_EXTENSIONS",
    "MAX_LANGUAGES",
    "REPORT_TIMEOUT",
    "ApiKeys",
    "Extension",
    "InstallationReporter",
    "LanguageMapping",
    "NameVersion",
    "PingResponse",
    "ReportEvent",
    "ReporterResult",
    "ReporterState",
    "StateInput",
    "normalize_extensions",
    "normalize_languages",
    "ping_response",
    "reporter_state",
    "reports_enabled",
]


def _default_report_url() -> str:
    """The live Plugin Health dashboard, from config.json next to this file (a copy of plugin-health/config.json)."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"), encoding="utf-8") as fh:
            url = json.load(fh).get("reportUrl")
        return url if isinstance(url, str) else ""
    except (OSError, ValueError, AttributeError):
        return ""


DEFAULT_REPORT_URL: Final = _default_report_url()
"""The live Plugin Health dashboard (config.json). SUPERTEXT_REPORT_URL overrides it; '' if config.json is missing."""
REPORT_TIMEOUT: Final = 3.0
"""Seconds a report may take."""
FAILURE_BACKOFF: Final = 3600.0
"""Seconds without a new report after a failed one (except :meth:`InstallationReporter.report_check`)."""

StateInput = Union["ReporterState", Mapping[str, Any], str, bytes, None]

ApiKeys = str | None | Mapping[str, str]
"""One key (a string), or several by name (``{"AI translation": key, ...}``, in the order the settings show them)."""

MAX_API_KEYS: Final = 20
"""At most this many named keys are checked and reported; the rest are ignored."""
"""A state as the plugin stored it: a :class:`ReporterState`, its ``to_dict()``, its JSON, or ``None``."""

ReportEvent = Literal["installed", "settings_saved", "upgraded", "api_key_check", "check", "extensions", "languages"]

Extension = Mapping[str, Any]
"""Another plugin, extension, module or theme installed on the site:
``{"name": "Polylang Pro", "version": "3.7.2", "active": True, "type": "plugin"}`` (only the name is required)."""

MAX_EXTENSIONS: Final = 500
"""At most this many installed plugins are sent; the rest are left out."""


LanguageMapping = Mapping[str, Any]
"""One language of the system and the Supertext code it is translated as:
``{"code": "de_CH", "supertext": "de-CH"}`` (``supertext`` None or left out: not mapped)."""

MAX_LANGUAGES: Final = 100
"""At most this many languages are sent; the rest are left out."""


def normalize_languages(languages: Iterable[LanguageMapping]) -> list[dict[str, Any]]:
    """The language mapping as it is sent.

    Codes trimmed and cut to 35 characters, a blank Supertext code sent as None, blank codes and repeats
    (same code, ignoring case) dropped, at most :data:`MAX_LANGUAGES`.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in languages:
        if len(out) >= MAX_LANGUAGES:
            break
        if not isinstance(entry, Mapping) or not isinstance(entry.get("code"), str):
            continue
        code = entry["code"].strip()[:35]
        if not code or code.lower() in seen:
            continue
        seen.add(code.lower())
        raw = entry.get("supertext")
        supertext = raw.strip()[:35] if isinstance(raw, str) else ""
        out.append({"code": code, "supertext": supertext or None})
    return out


def normalize_extensions(extensions: Iterable[Extension]) -> list[dict[str, Any]]:
    """The installed plugins as they are sent.

    Names and versions trimmed (100 and 50 characters), types in lower case (30), blank names and repeats
    (same type and name, ignoring case) dropped, at most :data:`MAX_EXTENSIONS`.
    """
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for e in extensions:
        if len(out) >= MAX_EXTENSIONS:
            break
        if not isinstance(e, Mapping) or not isinstance(e.get("name"), str):
            continue
        name = e["name"].strip()[:100]
        if not name:
            continue
        raw_type = e.get("type")
        type_ = raw_type.strip().lower()[:30] if isinstance(raw_type, str) else ""
        key = (type_, name.lower())
        if key in seen:
            continue
        seen.add(key)
        entry: dict[str, Any] = {"name": name}
        raw_version = e.get("version")
        version = raw_version.strip()[:50] if isinstance(raw_version, str) else ""
        if version:
            entry["version"] = version
        if isinstance(e.get("active"), bool):
            entry["active"] = e["active"]
        if type_:
            entry["type"] = type_
        out.append(entry)
    return out


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
    camelCase shape (``reportedVersions``, ``reportedKeyStatus``, ``lastFailureAt``, ``keyCheck``,
    ``keyChecks``, ``reportedKeyStatuses``) is the same in every language (the Supertext SDK 0.1 to 0.2
    reporter stored the first four). The last two are for plugins with several named keys.
    """

    reported_versions: str | None = None
    """``<plugin>|<system>|<runtime>`` versions last reported successfully."""
    reported_key_status: str | None = None
    """The key status last reported successfully."""
    last_failure_at: str | None = None
    """When the last report failed (no new attempt for an hour)."""
    key_check: KeyCheck | None = None
    """The latest key check (one key)."""
    key_checks: Mapping[str, KeyCheck] | None = None
    """Several keys: the latest check per name, in the plugin's order; ``None`` with one key."""
    reported_key_statuses: Mapping[str, str] | None = None
    """Several keys: the statuses last reported successfully, by name."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "reportedVersions": self.reported_versions,
            "reportedKeyStatus": self.reported_key_status,
            "lastFailureAt": self.last_failure_at,
            "keyCheck": self.key_check.to_dict() if self.key_check else None,
            "keyChecks": None if self.key_checks is None else {n: c.to_dict() for n, c in self.key_checks.items()},
            "reportedKeyStatuses": None if self.reported_key_statuses is None else dict(self.reported_key_statuses),
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(",", ":"))


@dataclass(frozen=True)
class ReporterResult:
    state: ReporterState
    """Store this."""
    check: KeyCheck | None
    """The latest key check (show it on the settings or status page); ``None`` with several keys."""
    event: ReportEvent | None
    """The event that was reported (or tried); ``None`` when nothing was due."""
    sent: bool
    """Whether the center accepted the report."""
    checks: Mapping[str, KeyCheck] | None = None
    """Several keys: the latest check per name; ``None`` with one key."""


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
    key_checks: dict[str, KeyCheck] | None = None
    raw_checks = data.get("keyChecks")
    if isinstance(raw_checks, Mapping):
        key_checks = {}
        for name, item in raw_checks.items():
            parsed = KeyCheck.from_value(item) if isinstance(item, Mapping) else None
            if parsed is not None:
                key_checks[str(name)] = parsed
    reported: dict[str, str] | None = None
    raw_reported = data.get("reportedKeyStatuses")
    if isinstance(raw_reported, Mapping):
        reported = {str(n): s for n, s in raw_reported.items() if isinstance(s, str)}
    return ReporterState(
        text("reportedVersions"), text("reportedKeyStatus"), text("lastFailureAt"), key_check, key_checks, reported
    )


def _named_keys(api_keys: Mapping[str, str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for raw, key in api_keys.items():
        name = str(raw).strip()[:60]
        if not name or any(n == name for n, _ in out):
            continue
        out.append((name, key if isinstance(key, str) else ""))
        if len(out) >= MAX_API_KEYS:
            break
    return out


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
    (``None`` for hosted apps). ``extensions`` optionally returns the installed plugins, so that every
    report carries them (leave it out to send them only by hand with :meth:`send_extensions`, the
    default). ``transport`` sends the report; ``now`` is the Unix time in seconds.
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
        extensions: Callable[[], Iterable[Extension]] | None = None,
        languages: Callable[[], Iterable[LanguageMapping]] | None = None,
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
        self._extensions = extensions
        self._languages = languages

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

    def after_settings_saved(self, state: StateInput, api_key: ApiKeys) -> ReporterResult:
        """After the plugin's settings were saved: checks the key(s), reports ``installed`` or ``settings_saved``."""
        current = self._with_checks(reporter_state(state), api_key, force=True)
        return self._report_if_due(current, "installed" if current.reported_versions is None else "settings_saved")

    def on_request(self, state: StateInput, api_key: ApiKeys) -> ReporterResult:
        """On back-end requests that run the plugin's code: checks changed keys, reports what changed."""
        current = self._with_checks(reporter_state(state), api_key, force=False)
        return self._report_if_due(current, self._due_event(current))

    def authentication_failed(
        self, state: StateInput, api_key: ApiKeys, http_status: int = 401, key_name: str | None = None
    ) -> ReporterResult:
        """A translation was rejected with 401/403: the key is invalid (no check against Supertext).

        With several keys, ``key_name`` says which one (the others keep their result; ``None``: all).
        """
        base = reporter_state(state)
        if isinstance(api_key, Mapping):
            current = self._with_checks(base, api_key, force=False)
            checks = dict(current.key_checks or {})
            for name, key in _named_keys(api_key):
                if key_name is None or name == key_name.strip():
                    checks[name] = self._invalid(key, http_status)
            current = replace(current, key_checks=checks)
        else:
            current = replace(
                base,
                key_check=self._invalid(api_key, http_status),
                key_checks=None,
                reported_key_statuses=None,
                reported_key_status=None if base.key_checks is not None else base.reported_key_status,
            )
        return self._report_if_due(current, self._due_event(current))

    def test_connection(self, state: StateInput, api_key: ApiKeys) -> ReporterResult:
        """The "Test connection" button: checks the key(s), reports a change."""
        current = self._with_checks(reporter_state(state), api_key, force=True)
        return self._report_if_due(current, self._due_event(current))

    def report_check(self, state: StateInput) -> ReporterResult:
        """Sends a ``check`` report now (commands, tests), even after a recent failure."""
        return self._send(reporter_state(state), "check")

    def send_extensions(self, state: StateInput, extensions: Iterable[Extension]) -> ReporterResult:
        """The plugin's "Send installed plugins to Supertext" button: sends event ``extensions`` with the list.

        Now, even after a recent failure, but only while reporting is on (``sent`` is False otherwise).
        """
        try:
            listed = normalize_extensions(extensions)
        except Exception:
            listed = []
        return self._send(reporter_state(state), "extensions", listed)

    def send_languages(self, state: StateInput, languages: Iterable[LanguageMapping]) -> ReporterResult:
        """The plugin's "Send language settings to Supertext" button: sends event ``languages`` with the mapping.

        Now, even after a recent failure, but only while reporting is on (``sent`` is False otherwise).
        """
        try:
            mapping = normalize_languages(languages)
        except Exception:
            mapping = []
        return self._send(reporter_state(state), "languages", None, mapping)

    def build_report(
        self,
        event: ReportEvent,
        state: StateInput,
        extensions: list[dict[str, Any]] | None = None,
        languages: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """The report body for an event and state (neither the key nor its fingerprint is part of it).

        ``extensions``, ``languages``: the installed plugins and the language mapping to send; default: the
        ``extensions`` and ``languages`` functions', if any.
        """
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
        if current.key_checks is not None:
            body["api_keys"] = [
                {"name": name, "configured": check.fingerprint != "", "check": _check_body(check)}
                for name, check in current.key_checks.items()
            ]
        elif current.key_check is not None:
            body["api_key_configured"] = current.key_check.fingerprint != ""
            body["api_key_check"] = _check_body(current.key_check)
        if self.callback_url:
            body["callback"] = {"url": self.callback_url}
        listed = extensions if extensions is not None else self._configured_extensions()
        if listed is not None:
            body["extensions"] = listed
        mapping = languages if languages is not None else self._configured_languages()
        if mapping is not None:
            body["languages"] = mapping
        return body

    def _configured_languages(self) -> list[dict[str, Any]] | None:
        if self._languages is None:
            return None
        try:
            return normalize_languages(self._languages())
        except Exception:
            return None  # never fails the report: the mapping is extra information

    def _configured_extensions(self) -> list[dict[str, Any]] | None:
        if self._extensions is None:
            return None
        try:
            return normalize_extensions(self._extensions())
        except Exception:
            return None  # never fails the report: the list is extra information

    # -- Internals ---------------------------------------------------------------------------

    def _due_event(self, state: ReporterState) -> ReportEvent | None:
        if state.reported_versions is None:
            return "installed"
        if state.reported_versions != self.versions:
            return "upgraded"
        if state.key_checks is not None:
            reported = state.reported_key_statuses or {}
            if len(reported) != len(state.key_checks) or any(
                reported.get(name) != check.status for name, check in state.key_checks.items()
            ):
                return "api_key_check"
            return None
        if state.key_check is not None and state.key_check.status != state.reported_key_status:
            return "api_key_check"
        return None

    def _with_checks(self, state: ReporterState, api_key: ApiKeys, *, force: bool) -> ReporterState:
        """The state with fresh checks: always (``force``), else only for keys that are new or changed."""
        if not isinstance(api_key, Mapping):
            if (
                not force
                and state.key_checks is None
                and state.key_check is not None
                and state.key_check.fingerprint == self._fingerprint(api_key)
            ):
                return state
            # Coming from several keys: report the single key even if its status is the one reported before.
            return replace(
                state,
                key_check=self._check(api_key),
                key_checks=None,
                reported_key_statuses=None,
                reported_key_status=None if state.key_checks is not None else state.reported_key_status,
            )
        checks: dict[str, KeyCheck] = {}
        for name, key in _named_keys(api_key):
            old = (state.key_checks or {}).get(name)
            checks[name] = (
                old if not force and old is not None and old.fingerprint == self._fingerprint(key) else self._check(key)
            )
        return replace(state, key_check=None, key_checks=checks)

    def _invalid(self, api_key: str | None, http_status: int) -> KeyCheck:
        return KeyCheck("invalid", iso_seconds(self._now()), http_status, None, self._fingerprint(api_key))

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
            return ReporterResult(state, state.key_check, None, False, state.key_checks)
        if state.last_failure_at is not None:
            failed = parse_iso(state.last_failure_at)
            if failed is not None and self._now() - failed < FAILURE_BACKOFF:
                return ReporterResult(state, state.key_check, None, False, state.key_checks)
        return self._send(state, event)

    def _send(
        self,
        state: ReporterState,
        event: ReportEvent,
        extensions: list[dict[str, Any]] | None = None,
        languages: list[dict[str, Any]] | None = None,
    ) -> ReporterResult:
        if not self._enabled:
            return ReporterResult(state, state.key_check, None, False, state.key_checks)
        ok = False
        try:
            report = self.build_report(event, state, extensions, languages)
            body = json.dumps(report, separators=(",", ":")).encode("utf-8")
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
            statuses = (
                {name: check.status for name, check in state.key_checks.items()}
                if state.key_checks is not None
                else state.reported_key_statuses
            )
            next_state = replace(
                state,
                reported_versions=self.versions,
                reported_key_status=key_status,
                reported_key_statuses=statuses,
                last_failure_at=None,
            )
        else:
            next_state = replace(state, last_failure_at=iso_seconds(self._now()))
        return ReporterResult(next_state, next_state.key_check, event, ok, next_state.key_checks)


def _check_body(check: KeyCheck) -> dict[str, Any]:
    entry: dict[str, Any] = {"status": check.status, "checked_at": check.checked_at}
    if check.http_status is not None:
        entry["http_status"] = check.http_status
    if check.error_code is not None:
        entry["error_code"] = check.error_code
    return entry


def _name_version(value: NameVersion) -> dict[str, str]:
    return {"name": value.name, "version": value.version} if value.version else {"name": value.name}
