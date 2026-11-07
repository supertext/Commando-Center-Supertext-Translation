"""Supertext Plugin Health: version reports to the Supertext Plugin Health dashboard, the API key check result
and the plugin's ping endpoint. Usage: ../README.md (plugin-health/README.md).

Plugins bundle a copy under their own import root, so the package uses relative imports only.
"""

from .key_check import CallableKeyChecker, KeyCheck, KeyChecker, iso_seconds, parse_iso
from .reporter import (
    DEFAULT_REPORT_URL,
    FAILURE_BACKOFF,
    MAX_API_KEYS,
    REPORT_TIMEOUT,
    ApiKeys,
    InstallationReporter,
    NameVersion,
    PingResponse,
    ReporterResult,
    ReporterState,
    ReportEvent,
    StateInput,
    ping_response,
    reporter_state,
    reports_enabled,
)
from .transport import HttpRequest, HttpResponse, Transport, UrllibTransport
from .version import PLUGIN_HEALTH_VERSION

__version__ = PLUGIN_HEALTH_VERSION

__all__ = [
    "DEFAULT_REPORT_URL",
    "FAILURE_BACKOFF",
    "MAX_API_KEYS",
    "PLUGIN_HEALTH_VERSION",
    "REPORT_TIMEOUT",
    "ApiKeys",
    "CallableKeyChecker",
    "HttpRequest",
    "HttpResponse",
    "InstallationReporter",
    "KeyCheck",
    "KeyChecker",
    "NameVersion",
    "PingResponse",
    "ReportEvent",
    "ReporterResult",
    "ReporterState",
    "StateInput",
    "Transport",
    "UrllibTransport",
    "__version__",
    "iso_seconds",
    "parse_iso",
    "ping_response",
    "reporter_state",
    "reports_enabled",
]
