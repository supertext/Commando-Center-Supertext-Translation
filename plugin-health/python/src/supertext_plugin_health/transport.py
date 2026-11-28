"""HTTP for the report: the one place that does I/O, so tests and plugins can replace it."""

from __future__ import annotations

import http.client
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

__all__ = ["HttpRequest", "HttpResponse", "Transport", "UrllibTransport"]


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes | None = None
    timeout: float = 3.0


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes = b""


class Transport(Protocol):
    """Sends one request and returns the answer, whatever its status.

    Raise an exception (e.g. :class:`OSError`) when there is no HTTP answer at all.
    """

    def __call__(self, request: HttpRequest) -> HttpResponse: ...


class UrllibTransport:
    """Default transport on :mod:`urllib.request` (honours the usual proxy environment variables)."""

    def __call__(self, request: HttpRequest) -> HttpResponse:
        req = urllib.request.Request(
            request.url, data=request.body, headers=dict(request.headers), method=request.method
        )
        try:
            # nosemgrep: dynamic-urllib-use-detected -- fixed Plugin Health URL (or the site's SUPERTEXT_REPORT_URL)
            with urllib.request.urlopen(req, timeout=request.timeout) as response:
                return HttpResponse(response.status, response.read(64 * 1024))
        except urllib.error.HTTPError as error:
            # Non-2xx answers are answers, not transport failures.
            with error:
                return HttpResponse(error.code)
        except http.client.HTTPException as error:
            raise OSError(f"{type(error).__name__}: {error}") from error
