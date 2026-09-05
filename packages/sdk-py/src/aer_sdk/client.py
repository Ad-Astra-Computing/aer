"""AER Python SDK: ingest events into a session and seal it into a signed record.

Design parity with @adastracomputing/aer-sdk-ts:
  - events are buffered and posted in batches (size- and interval-triggered)
  - 5xx responses retry with exponential backoff; 4xx fail fast
  - a failed batch is requeued so an explicit retry can drain it
  - complete() flushes then seals the session; abort() is the crash path
  - a closed client refuses further emits

Capture discipline: AER is bodies-off. Emit metadata only (model names, token
counts, tool names, hosts, paths); never prompts, completions, arguments or
response bodies. The server strips unrecognised payload keys at ingest.

Stdlib only: the transport is urllib by default and injectable for tests.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from ._version import __version__
from .uuid7 import uuid7

Transport = Callable[[str, str, dict, Optional[bytes]], tuple]
SEVERITIES = ("info", "low", "medium", "high", "critical")
DEFAULT_TIMEOUT_S = 30.0


class AerIngestError(Exception):
    """A request the SDK will not retry (4xx) or that exhausted its retries."""

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


def _require_safe_base_url(base_url: str) -> str:
    """HTTPS only, with a localhost development exception: a bearer ingest
    token must never ride plain HTTP to a remote host."""
    base = base_url.rstrip("/")
    if base.startswith("https://"):
        return base
    if base.startswith("http://localhost") or base.startswith("http://127.0.0.1"):
        return base
    raise ValueError("base_url must be https:// (http:// is allowed for localhost only)")


def _make_default_transport(timeout_s: float) -> Transport:
    """Build the stdlib urllib transport, closed over a fixed timeout.

    Production's edge blocks the bare `Python-urllib/x.y` default User-Agent
    with an empty-body 403 - confirmed against api.aer.run, any other UA
    (including curl's) succeeds. Every request must therefore identify
    itself, or the SDK fails out of the box with zero configuration.
    """

    def transport(url: str, method: str, headers: dict, body: Optional[bytes]) -> tuple:
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("User-Agent", f"aer-sdk-py/{__version__}")
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as res:  # noqa: S310 (https URLs only in practice)
                return res.status, res.read()
        except urllib.error.HTTPError as err:  # 4xx/5xx still carry a body
            return err.code, err.read()

    return transport


_default_transport = _make_default_transport(DEFAULT_TIMEOUT_S)


def _request_json(transport: Transport, url: str, method: str, token: str,
                  payload: Optional[Any]) -> tuple:
    headers = {"authorization": f"Bearer {token}"}
    body = None
    if payload is not None:
        headers["content-type"] = "application/json"
        body = json.dumps(payload).encode()
    status, raw = transport(url, method, headers, body)
    try:
        parsed = json.loads(raw) if raw else {}
    except ValueError:
        parsed = {}
    return status, parsed


def create_session(*, base_url: str, tenant_api_key: str, tenant_id: str,
                   agent_id: str, agent_version: str, environment_id: str,
                   transport: Optional[Transport] = None,
                   request_timeout_s: float = DEFAULT_TIMEOUT_S) -> dict:
    """Create a session with a tenant API key; returns ids and the ingest token."""
    t = transport or _make_default_transport(request_timeout_s)
    url = f"{_require_safe_base_url(base_url)}/v1/sessions"
    status, body = _request_json(t, url, "POST", tenant_api_key, {
        "tenant_id": tenant_id,
        "agent_id": agent_id,
        "agent_version": agent_version,
        "environment_id": environment_id,
    })
    if status != 201:
        raise AerIngestError(f"AER session create failed: {status} {body}", status)
    return body


class AerClient:
    def __init__(self, *, base_url: str, session_id: str, ingest_token: str,
                 batch_size: int = 50, flush_interval_ms: int = 500,
                 max_retries: int = 3, retry_base_ms: int = 100,
                 request_timeout_s: float = DEFAULT_TIMEOUT_S,
                 transport: Optional[Transport] = None,
                 clock: Optional[Callable[[], float]] = None,
                 on_ingest_result: Optional[Callable[[dict], None]] = None):
        self._base = _require_safe_base_url(base_url)
        self._session = session_id
        self._token = ingest_token
        self._batch = max(1, batch_size)
        self._max_retries = max(0, max_retries)
        self._retry_base = max(0, retry_base_ms) / 1000.0
        self._transport = transport or _make_default_transport(request_timeout_s)
        self._clock = clock or time.time
        self._on_ingest_result = on_ingest_result
        self._stats = {"accepted": 0, "rejected": 0}
        self._stats_lock = threading.Lock()

        self._buffer: list = []
        self._lock = threading.RLock()
        # Serialises whole flush passes (mirrors the TS client's inflightFlush):
        # without it, a background flush racing a user flush could interleave
        # batches or reorder a requeued failure.
        self._flush_lock = threading.Lock()
        self._closed = False

        self._timer: Optional[threading.Thread] = None
        self._stop = threading.Event()
        if flush_interval_ms > 0:
            interval = flush_interval_ms / 1000.0

            def loop() -> None:
                while not self._stop.wait(interval):
                    try:
                        with self._lock:
                            pending = bool(self._buffer) and not self._closed
                        if pending:
                            self.flush()
                    except Exception:  # noqa: BLE001 background flush never raises
                        pass

            self._timer = threading.Thread(target=loop, daemon=True)
            self._timer.start()

    # ── public API ────────────────────────────────────────────────────────────

    def emit(self, event_type: str, payload: dict, *, severity_hint: str = "info") -> None:
        if self._closed:
            raise RuntimeError("AerClient is closed")
        if severity_hint not in SEVERITIES:
            raise ValueError(f"severity_hint must be one of {SEVERITIES}")
        # Freeze the payload now: a caller mutating its dict after emit must
        # not change what the background thread serialises, and a non-JSON
        # value should fail loudly here, not inside the flush thread.
        try:
            frozen = json.loads(json.dumps(payload))
        except (TypeError, ValueError) as err:
            raise TypeError(f"payload must be JSON-serialisable: {err}") from err
        # One clock read, converted to integer milliseconds once: separate float
        # operations could tear the seconds and milliseconds apart or misround
        # at boundaries.
        ms_total = int(round(self._clock() * 1000))
        ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms_total // 1000))
        ms = ms_total % 1000
        event = {
            "event_id": uuid7(),
            "agent_session_id": self._session,
            "event_type": event_type,
            "source_type": "sdk",
            "severity_hint": severity_hint,
            "timestamp_observed": f"{ts}.{ms:03d}Z",
            "payload": frozen,
        }
        drain = False
        with self._lock:
            self._buffer.append(event)
            drain = len(self._buffer) >= self._batch
        if drain:
            self.flush()

    def flush(self) -> list:
        """Post every buffered batch. Returns the per-batch ingest results.

        A 207 response is transport success with per-event rejections inside
        (`rejected` and `errors`); rejected events are deliberately not
        requeued. Every result - whether from this explicit call or from the
        background timer or a size-triggered flush nested inside emit() -
        also updates stats() and, if configured, on_ingest_result(), so a
        207 from a flush the caller did not itself await is still visible.
        """
        results = []
        with self._flush_lock:
            while True:
                with self._lock:
                    if not self._buffer:
                        return results
                    chunk = self._buffer[: self._batch]
                    del self._buffer[: len(chunk)]
                try:
                    result = self._post_with_retry(chunk)
                except Exception:
                    with self._lock:
                        self._buffer[0:0] = chunk  # requeue for the next flush
                    raise
                results.append(result)
                self._record_result(result)

    def stats(self) -> dict:
        """Cumulative accepted/rejected counts across every flush so far,
        including ones triggered internally that the caller never awaited."""
        with self._stats_lock:
            return dict(self._stats)

    def _record_result(self, result: dict) -> None:
        accepted = result.get("accepted") or 0
        rejected = result.get("rejected") or 0
        with self._stats_lock:
            self._stats["accepted"] += accepted
            self._stats["rejected"] += rejected
        if self._on_ingest_result is not None:
            try:
                self._on_ingest_result(result)
            except Exception:  # noqa: BLE001 the caller's callback must never break a flush
                pass

    def complete(self) -> dict:
        self.flush()
        url = f"{self._base}/v1/sessions/{self._session}/complete"
        status, body = _request_json(self._transport, url, "POST", self._token, None)
        if status != 200:
            raise AerIngestError(f"AER complete failed: {status} {body}", status)
        return body

    def abort(self) -> None:
        """Crash-recovery: terminate without generating a record. 409 tolerated."""
        self.flush()
        url = f"{self._base}/v1/sessions/{self._session}/abort"
        status, body = _request_json(self._transport, url, "POST", self._token, None)
        if status not in (200, 409):
            raise AerIngestError(f"AER abort failed: {status} {body}", status)

    def close(self) -> None:
        with self._lock:
            self._closed = True
        self._stop.set()
        self.flush()

    def __enter__(self) -> "AerClient":
        return self

    def __exit__(self, exc_type, _exc, _tb) -> None:
        if exc_type is None:
            self.close()
            return
        # Crash path: stop the flusher, drop the buffer (its events may be part
        # of the failure) and terminate the remote session so it is not left
        # running. Best-effort: never mask the original exception.
        self._stop.set()
        with self._lock:
            self._closed = True
            self._buffer.clear()
        try:
            url = f"{self._base}/v1/sessions/{self._session}/abort"
            _request_json(self._transport, url, "POST", self._token, None)
        except Exception:  # noqa: BLE001
            pass

    # ── internals ─────────────────────────────────────────────────────────────

    def _post_with_retry(self, chunk: list) -> dict:
        url = f"{self._base}/v1/sessions/{self._session}/events"
        last: Optional[AerIngestError] = None
        for attempt in range(self._max_retries + 1):
            status, body = _request_json(self._transport, url, "POST", self._token, chunk)
            if status in (202, 207):
                return body
            if 400 <= status < 500:
                raise AerIngestError(f"AER ingest failed: {status} {body}", status)
            last = AerIngestError(f"AER ingest {status}", status)
            time.sleep(self._retry_base * (2 ** attempt))
        raise last or AerIngestError("AER ingest failed after retries")
