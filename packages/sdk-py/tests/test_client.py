"""Contract tests for the AER Python SDK.

Mirrors the TypeScript SDK's behaviour: batching, explicit and size-triggered
flushes, retry with exponential backoff on 5xx, fail-fast on 4xx, complete and
abort flows, and closed-client protection. The transport is injected so tests
never open sockets.
"""

import json
import threading
import time

import pytest

from aer_sdk import AerClient, AerIngestError, create_session
from aer_sdk.uuid7 import uuid7


class FakeTransport:
    """Records requests; scripted responses per call index."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.lock = threading.Lock()

    def __call__(self, url, method, headers, body):
        with self.lock:
            self.requests.append({
                "url": url, "method": method, "headers": headers,
                "body": json.loads(body) if body else None,
            })
            if not self.responses:
                raise AssertionError("transport called more times than scripted")
            status, payload = self.responses.pop(0)
            return status, json.dumps(payload).encode()


def make_client(transport, **over):
    defaults = dict(
        base_url="https://api.aer.run",
        session_id="00000000-0000-7000-8000-000000000001",
        ingest_token="tok-1",
        batch_size=3,
        flush_interval_ms=0,  # no background timer in tests
        max_retries=2,
        retry_base_ms=1,
        transport=transport,
    )
    defaults.update(over)
    return AerClient(**defaults)


class TestUuid7:
    def test_shape_and_version(self):
        u = uuid7()
        assert len(u) == 36
        assert u[14] == "7"
        assert u[19] in "89ab"

    def test_uniqueness(self):
        assert len({uuid7() for _ in range(1000)}) == 1000


class TestEmitAndFlush:
    def test_emit_buffers_until_batch_size_then_posts_one_batch(self):
        t = FakeTransport([(202, {"accepted": 3, "rejected": 0, "errors": []})])
        c = make_client(t)
        c.emit("tool.started", {"tool": "search"})
        c.emit("tool.completed", {"tool": "search", "ok": True})
        assert t.requests == []  # under batch size, nothing sent yet
        c.emit("http.requested", {"host": "api.example.com", "method": "GET"})
        assert len(t.requests) == 1
        req = t.requests[0]
        assert req["url"].endswith("/v1/sessions/00000000-0000-7000-8000-000000000001/events")
        assert req["headers"]["authorization"] == "Bearer tok-1"
        batch = req["body"]
        assert len(batch) == 3
        for ev in batch:
            assert ev["source_type"] == "sdk"
            assert ev["agent_session_id"] == "00000000-0000-7000-8000-000000000001"
            assert ev["event_id"][14] == "7"
            assert "timestamp_observed" in ev

    def test_explicit_flush_drains_buffer(self):
        t = FakeTransport([(202, {"accepted": 1, "rejected": 0, "errors": []})])
        c = make_client(t)
        c.emit("tool.started", {"tool": "x"})
        results = c.flush()
        assert results[0]["accepted"] == 1
        assert len(t.requests) == 1

    def test_flush_on_empty_buffer_is_a_noop(self):
        t = FakeTransport([])
        c = make_client(t)
        assert c.flush() == []


class TestRetries:
    def test_retries_5xx_with_backoff_then_succeeds(self):
        t = FakeTransport([
            (500, {}),
            (202, {"accepted": 1, "rejected": 0, "errors": []}),
        ])
        c = make_client(t)
        c.emit("tool.started", {"tool": "x"})
        results = c.flush()
        assert results[0]["accepted"] == 1
        assert len(t.requests) == 2

    def test_fails_fast_on_4xx_without_retry(self):
        t = FakeTransport([(400, {"error": "invalid"})])
        c = make_client(t)
        c.emit("tool.started", {"tool": "x"})
        with pytest.raises(AerIngestError):
            c.flush()
        assert len(t.requests) == 1

    def test_failed_batch_is_requeued_for_the_next_flush(self):
        t = FakeTransport([
            (500, {}), (500, {}), (500, {}),  # exhausts max_retries=2 (3 attempts)
            (202, {"accepted": 1, "rejected": 0, "errors": []}),
        ])
        c = make_client(t)
        c.emit("tool.started", {"tool": "x"})
        with pytest.raises(AerIngestError):
            c.flush()
        results = c.flush()
        assert results[0]["accepted"] == 1


class TestLifecycle:
    def test_complete_flushes_then_posts_complete(self):
        t = FakeTransport([
            (202, {"accepted": 1, "rejected": 0, "errors": []}),
            (200, {"aer_id": "a-1", "canonical_hash": "c" * 64,
                   "signing_key_id": "k1", "findings_count": 0}),
        ])
        c = make_client(t)
        c.emit("tool.started", {"tool": "x"})
        res = c.complete()
        assert res["aer_id"] == "a-1"
        assert t.requests[1]["url"].endswith("/complete")

    def test_abort_tolerates_409(self):
        t = FakeTransport([(409, {"error": "not_running"})])
        c = make_client(t)
        c.abort()  # must not raise
        assert t.requests[0]["url"].endswith("/abort")

    def test_emit_after_close_raises(self):
        t = FakeTransport([])
        c = make_client(t)
        c.close()
        with pytest.raises(RuntimeError):
            c.emit("tool.started", {"tool": "x"})

    def test_close_flushes_remaining_events(self):
        t = FakeTransport([(202, {"accepted": 1, "rejected": 0, "errors": []})])
        c = make_client(t)
        c.emit("tool.started", {"tool": "x"})
        c.close()
        assert len(t.requests) == 1


class TestBackgroundFlush:
    def test_interval_flush_drains_without_explicit_calls(self):
        t = FakeTransport([(202, {"accepted": 1, "rejected": 0, "errors": []})])
        c = make_client(t, flush_interval_ms=20)
        c.emit("tool.started", {"tool": "x"})
        deadline = time.time() + 2
        while not t.requests and time.time() < deadline:
            time.sleep(0.01)
        c.close()
        assert len(t.requests) >= 1


class TestCreateSession:
    def test_posts_tenant_key_and_returns_session(self):
        t = FakeTransport([(201, {
            "agent_session_id": "s-1", "ingest_token": "itok",
            "tenant_id": "t-1", "agent_id": "a-1",
        })])
        res = create_session(
            base_url="https://api.aer.run/",
            tenant_api_key="key-1",
            tenant_id="t-1", agent_id="a-1", agent_version="1.0.0",
            environment_id="e-1",
            transport=t,
        )
        assert res["agent_session_id"] == "s-1"
        req = t.requests[0]
        assert req["url"] == "https://api.aer.run/v1/sessions"
        assert req["headers"]["authorization"] == "Bearer key-1"
        assert req["body"]["agent_version"] == "1.0.0"

    def test_raises_on_error_status(self):
        t = FakeTransport([(403, {"error": "tenant_mismatch"})])
        with pytest.raises(AerIngestError):
            create_session(
                base_url="https://api.aer.run", tenant_api_key="k",
                tenant_id="t", agent_id="a", agent_version="1", environment_id="e",
                transport=t,
            )


class TestTimestamps:
    def test_timestamp_is_strict_iso_ms_from_a_single_clock_read(self):
        # A clock that jumps a full second between successive reads would tear
        # the seconds and milliseconds apart if read twice.
        reads = iter([1749999999.999, 1750000000.000, 1750000001.500])
        t = FakeTransport([(202, {"accepted": 1, "rejected": 0, "errors": []})])
        c = make_client(t, clock=lambda: next(reads))
        c.emit("tool.started", {"tool": "x"})
        c.flush()
        ts = t.requests[0]["body"][0]["timestamp_observed"]
        import re
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", ts)
        assert ts.endswith(".999Z")  # from the FIRST read only, never torn


class TestConcurrency:
    def test_concurrent_flushes_never_double_send_and_preserve_order(self):
        # A slow transport plus two racing flush() calls: every event must be
        # sent exactly once, in emit order, with flushes serialised.
        import threading as th

        gate = th.Event()
        sent_batches = []
        lock = th.Lock()

        def slow_transport(url, method, headers, body):
            if url.endswith("/events"):
                gate.wait(timeout=2)
                with lock:
                    sent_batches.append([e["payload"]["tool"] for e in json.loads(body)])
            return 202, json.dumps({"accepted": 1, "rejected": 0, "errors": []}).encode()

        c = make_client(slow_transport, batch_size=2)
        for i in range(4):
            # batch_size=2 triggers a flush inside emit; run emits on a thread
            # so the gated transport does not deadlock the test.
            pass
        emitter = th.Thread(target=lambda: [c.emit("tool.started", {"tool": f"t{i}"}) for i in range(4)])
        emitter.start()
        racer = th.Thread(target=lambda: c.flush())
        racer.start()
        time.sleep(0.05)
        gate.set()
        emitter.join(timeout=3)
        racer.join(timeout=3)
        c.flush()

        flat = [t for batch in sent_batches for t in batch]
        assert sorted(flat) == sorted([f"t{i}" for i in range(4)])  # exactly once each
        assert flat == [f"t{i}" for i in range(4)]  # and in emit order


class TestCodexFindings:
    def test_exit_on_exception_aborts_the_remote_session(self):
        t = FakeTransport([(200, {"ok": True})])
        try:
            with make_client(t) as c:
                c.emit("tool.started", {"tool": "x"})  # buffered
                raise RuntimeError("agent crashed")
        except RuntimeError:
            pass
        # abort flushed the buffer? No: crash path drops the buffer and aborts.
        assert t.requests[-1]["url"].endswith("/abort")

    def test_payloads_are_frozen_at_emit_time(self):
        t = FakeTransport([(202, {"accepted": 1, "rejected": 0, "errors": []})])
        c = make_client(t)
        payload = {"tool": "original"}
        c.emit("tool.started", payload)
        payload["tool"] = "mutated-after-emit"
        c.flush()
        assert t.requests[0]["body"][0]["payload"]["tool"] == "original"

    def test_non_json_payload_fails_loudly_at_emit(self):
        c = make_client(FakeTransport([]))
        with pytest.raises(TypeError):
            c.emit("tool.started", {"bad": object()})

    def test_http_base_url_is_rejected_unless_localhost(self):
        with pytest.raises(ValueError):
            make_client(FakeTransport([]), base_url="http://api.aer.run")
        # localhost development exception
        make_client(FakeTransport([]), base_url="http://localhost:8787")
        make_client(FakeTransport([]), base_url="http://127.0.0.1:8787")


class TestDefaultTransportUserAgent:
    """Production's edge rejects the bare urllib default User-Agent with a
    403. The default transport must always identify itself so the SDK works
    out of the box against the real API."""

    def test_default_transport_sets_user_agent_header(self, monkeypatch):
        from aer_sdk import client as client_module
        from aer_sdk._version import __version__

        captured = {}

        class FakeResponse:
            status = 201

            def read(self):
                return b"{}"

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            captured["headers"] = dict(req.header_items())
            captured["timeout"] = timeout
            return FakeResponse()

        monkeypatch.setattr(client_module.urllib.request, "urlopen", fake_urlopen)

        transport = client_module._make_default_transport(30.0)
        transport("https://api.aer.run/v1/sessions", "POST", {"authorization": "Bearer x"}, b"{}")

        assert captured["headers"].get("User-agent") == f"aer-sdk-py/{__version__}"

    def test_default_transport_used_by_create_session_carries_the_ua(self, monkeypatch):
        from aer_sdk import client as client_module

        captured = {}

        class FakeResponse:
            status = 201

            def read(self):
                return b'{"agent_session_id": "s", "ingest_token": "t"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            captured["headers"] = dict(req.header_items())
            return FakeResponse()

        monkeypatch.setattr(client_module.urllib.request, "urlopen", fake_urlopen)

        create_session(
            base_url="https://api.aer.run", tenant_api_key="k",
            tenant_id="t", agent_id="a", agent_version="1", environment_id="e",
        )
        assert "User-agent" in captured["headers"]


class TestConfigurableTimeout:
    def test_default_transport_honors_request_timeout_s(self, monkeypatch):
        from aer_sdk import client as client_module

        captured = {}

        class FakeResponse:
            status = 202

            def read(self):
                return b'{"accepted": 0, "rejected": 0, "errors": []}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            captured["timeout"] = timeout
            return FakeResponse()

        monkeypatch.setattr(client_module.urllib.request, "urlopen", fake_urlopen)

        c = AerClient(
            base_url="https://api.aer.run",
            session_id="00000000-0000-7000-8000-000000000001",
            ingest_token="tok-1",
            batch_size=1,
            flush_interval_ms=0,
            request_timeout_s=5.0,
        )
        c.emit("tool.started", {"tool": "x"})
        assert captured["timeout"] == 5.0

    def test_create_session_honors_request_timeout_s(self, monkeypatch):
        from aer_sdk import client as client_module

        captured = {}

        class FakeResponse:
            status = 201

            def read(self):
                return b'{"agent_session_id": "s", "ingest_token": "t"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            captured["timeout"] = timeout
            return FakeResponse()

        monkeypatch.setattr(client_module.urllib.request, "urlopen", fake_urlopen)

        create_session(
            base_url="https://api.aer.run", tenant_api_key="k",
            tenant_id="t", agent_id="a", agent_version="1", environment_id="e",
            request_timeout_s=2.5,
        )
        assert captured["timeout"] == 2.5


class TestIngestResultSurfacing:
    """A 207 (or any rejected>0 / dropped_keys / warning) from a flush the
    caller did not itself trigger - the interval timer, or a size-triggered
    flush nested inside another emit() - must still be observable, mirroring
    the TS SDK's onIngestResult."""

    def test_on_ingest_result_called_for_size_triggered_flush(self):
        t = FakeTransport([(207, {"accepted": 1, "rejected": 1, "errors": [{"index": 1}]})])
        seen = []
        c = make_client(t, batch_size=2, on_ingest_result=lambda r: seen.append(r))
        c.emit("tool.started", {"tool": "ok"})
        c.emit("tool.completed", {"tool": "bad"})  # crosses batch_size=2
        assert seen == [{"accepted": 1, "rejected": 1, "errors": [{"index": 1}]}]

    def test_on_ingest_result_called_for_background_flush(self):
        t = FakeTransport([(207, {"accepted": 1, "rejected": 1, "errors": [{"index": 0}]})])
        seen = []
        c = make_client(t, flush_interval_ms=20, on_ingest_result=lambda r: seen.append(r))
        c.emit("tool.started", {"tool": "x"})
        deadline = time.time() + 2
        while not seen and time.time() < deadline:
            time.sleep(0.01)
        c.close()
        assert seen and seen[0]["rejected"] == 1

    def test_stats_accumulate_accepted_and_rejected(self):
        t = FakeTransport([
            (207, {"accepted": 1, "rejected": 1, "errors": [{"index": 0}]}),
            (202, {"accepted": 2, "rejected": 0, "errors": []}),
        ])
        c = make_client(t, batch_size=1)
        c.emit("tool.started", {"tool": "a"})
        c.flush()
        c.emit("tool.started", {"tool": "b"})
        c.flush()
        stats = c.stats()
        assert stats["accepted"] == 3
        assert stats["rejected"] == 1

    def test_a_broken_callback_never_breaks_the_flush(self):
        t = FakeTransport([(202, {"accepted": 1, "rejected": 0, "errors": []})])
        c = make_client(t, batch_size=1, on_ingest_result=lambda r: (_ for _ in ()).throw(RuntimeError("boom")))
        c.emit("tool.started", {"tool": "x"})
        results = c.flush()
        assert results == []  # already flushed by size-trigger; nothing left to flush
        assert len(t.requests) == 1
