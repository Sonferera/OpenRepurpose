"""Security regression tests covering all 6 leads from docs/security-audit/NEEDS-VALIDATION.md."""

from __future__ import annotations

import asyncio
import hashlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.catalog import CATALOG
from api.mcp_keys import MCPKeyStore
from api.mcp_server import _build_http_transport_security, create_mcp_server
from api.server import (
    STATE,
    _MCP_HTTP_APP,
    _RATE_BUCKETS,
    _AuthenticatedMcpASGIApp,
    app,
)
from ml.data_loader import PINNED_RAW_DATASET_SHA256, download_verified_file
from ml.tests.test_api import ASPIRIN_SMILES, VALID_SEQUENCE, _setup_mock_catalog

_INIT_RPC = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "sec-test", "version": "1.0"},
    },
}


# ---------------------------------------------------------------------------
# Lead 1: api-mcp-keys-unauth-access
# ---------------------------------------------------------------------------


def test_mcp_key_management_blocks_proxy_cross_origin_and_enforces_admin_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _RATE_BUCKETS.clear()
    monkeypatch.delenv("OPENREPURPOSE_ADMIN_TOKEN", raising=False)
    isolated_store = MCPKeyStore(store_path=tmp_path / "keys.json", max_active_keys=2)

    with patch("api.server.MCP_KEY_STORE", isolated_store):
        client = TestClient(app, base_url="http://127.0.0.1:8000")

        # 1. Proxied / tunneled callers blocked without OPENREPURPOSE_ADMIN_TOKEN
        for hdr_name, hdr_val in (
            ("X-Forwarded-For", "203.0.113.42"),
            ("Forwarded", "for=203.0.113.42"),
            ("CF-Connecting-IP", "203.0.113.42"),
        ):
            r = client.get("/api/mcp/keys", headers={hdr_name: hdr_val})
            assert r.status_code == 403, f"Expected 403 for {hdr_name}, got {r.status_code}"

        # 2. Disallowed browser Origin blocked
        r_evil = client.post(
            "/api/mcp/keys",
            json={"label": "Evil Site"},
            headers={"Origin": "https://evil.attacker.example"},
        )
        assert r_evil.status_code == 403

        # 3. Cross-site browser request without allowed Origin blocked
        r_xsite = client.get("/api/mcp/keys", headers={"Sec-Fetch-Site": "cross-site"})
        assert r_xsite.status_code == 403

        # 4. Allowed local Studio Origin succeeds on direct loopback
        r_ok = client.post(
            "/api/mcp/keys",
            json={"label": "Local Studio"},
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        assert r_ok.status_code == 200
        key_id_1 = r_ok.json()["id"]

        # 5. Active key cap prevents unbounded minting
        assert client.post("/api/mcp/keys", json={"label": "Key 2"}).status_code == 200
        r_cap = client.post("/api/mcp/keys", json={"label": "Key 3 Overflow"})
        assert r_cap.status_code == 429

        # 6. Explicit OPENREPURPOSE_ADMIN_TOKEN mode enforces constant-time admin auth
        monkeypatch.setenv("OPENREPURPOSE_ADMIN_TOKEN", "super-secret-admin-token-123")
        assert client.get("/api/mcp/keys").status_code == 401
        assert (
            client.get("/api/mcp/keys", headers={"X-Admin-Token": "wrong-token"}).status_code
            == 401
        )
        r_admin_ok = client.delete(
            f"/api/mcp/keys/{key_id_1}",
            headers={
                "X-Admin-Token": "super-secret-admin-token-123",
                "X-Forwarded-For": "203.0.113.42",
            },
        )
        assert r_admin_ok.status_code == 200
        assert r_admin_ok.json()["revoked"] is True


# ---------------------------------------------------------------------------
# Lead 2: mcp-mount-unauth
# ---------------------------------------------------------------------------


def test_mounted_mcp_subapp_routes_and_fail_closed_asgi_wrapper(tmp_path: Path) -> None:
    pytest.importorskip("mcp")
    assert _MCP_HTTP_APP is not None

    # Verify installed mcp SDK registers only /mcp
    registered_paths = [getattr(r, "path", None) for r in _MCP_HTTP_APP.routes]
    assert registered_paths == ["/mcp"]

    # Verify fail-closed ASGI wrapper rejects BOTH unexpected paths AND unauthenticated /mcp
    called_paths: list[str] = []

    async def _dummy_inner(scope, receive, send):
        called_paths.append(scope["path"])
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": b'{"ok":true}'})

    isolated_store = MCPKeyStore(store_path=tmp_path / "asgi_keys.json")
    raw_key = isolated_store.create_key("ASGI Test")["api_key"]
    wrapped = _AuthenticatedMcpASGIApp(_dummy_inner)

    async def _invoke(path: str, headers: list[tuple[bytes, bytes]]) -> int:
        status_holder: list[int] = []

        async def _receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def _send(msg):
            if msg["type"] == "http.response.start":
                status_holder.append(int(msg["status"]))

        scope = {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": headers,
        }
        await wrapped(scope, _receive, _send)
        return status_holder[0]

    with patch("api.server.MCP_KEY_STORE", isolated_store):
        # Unexpected sub-app route returns 404 even WITH a valid key
        assert (
            asyncio.run(_invoke("/unexpected-debug-route", [(b"x-api-key", raw_key.encode())]))
            == 404
        )
        # Unauthenticated /mcp returns 401
        assert asyncio.run(_invoke("/mcp", [])) == 401
        assert called_paths == []
        # Authenticated /mcp passes through
        assert asyncio.run(_invoke("/mcp", [(b"x-api-key", raw_key.encode())])) == 200
        assert called_paths == ["/mcp"]


# ---------------------------------------------------------------------------
# Lead 3: localhost-bridge-dns-rebinding
# ---------------------------------------------------------------------------


def test_mcp_dns_rebinding_protection_enabled_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    _RATE_BUCKETS.clear()
    monkeypatch.delenv("MCP_DISABLE_DNS_REBINDING_PROTECTION", raising=False)
    monkeypatch.delenv("MCP_ALLOWED_HOSTS", raising=False)

    sec = _build_http_transport_security()
    assert sec.enable_dns_rebinding_protection is True
    assert "127.0.0.1:*" in sec.allowed_hosts
    assert "localhost:*" in sec.allowed_hosts

    isolated_store = MCPKeyStore(store_path=tmp_path / "dns_keys.json")
    raw_key = isolated_store.create_key("DNS Rebind Test")["api_key"]

    fresh_mcp = create_mcp_server(
        stateless_http=True,
        streamable_http_path="/mcp",
        json_response=True,
    )

    @asynccontextmanager
    async def _fresh_lifespan(_app: FastAPI):
        async with fresh_mcp.session_manager.run():
            yield

    test_app = FastAPI(lifespan=_fresh_lifespan)
    test_app.mount("/", _AuthenticatedMcpASGIApp(fresh_mcp.streamable_http_app()))

    with patch("api.server.MCP_KEY_STORE", isolated_store):
        with TestClient(test_app, base_url="http://127.0.0.1:8000") as client:
            # 1. Forged Host header (DNS rebinding) rejected with HTTP 421
            r_bad_host = client.post(
                "/mcp",
                json=_INIT_RPC,
                headers={
                    "Host": "evil.attacker.example:8000",
                    "Accept": "application/json, text/event-stream",
                    "X-API-Key": raw_key,
                },
            )
            assert r_bad_host.status_code == 421

            # 2. Disallowed cross-origin browser Origin rejected with HTTP 403
            r_bad_origin = client.post(
                "/mcp",
                json=_INIT_RPC,
                headers={
                    "Origin": "https://evil.attacker.example",
                    "Accept": "application/json, text/event-stream",
                    "X-API-Key": raw_key,
                },
            )
            assert r_bad_origin.status_code == 403

            # 3. Valid loopback Host succeeds with HTTP 200
            r_good = client.post(
                "/mcp",
                json=_INIT_RPC,
                headers={
                    "Accept": "application/json, text/event-stream",
                    "X-API-Key": raw_key,
                },
            )
            assert r_good.status_code == 200

            # 4. Unauthenticated /mcp rejected with HTTP 401 by ASGI wrapper
            r_unauth = client.post(
                "/mcp",
                json=_INIT_RPC,
                headers={"Accept": "application/json, text/event-stream"},
            )
            assert r_unauth.status_code == 401


# ---------------------------------------------------------------------------
# Lead 4: mcp-key-store-lost-update
# ---------------------------------------------------------------------------


def test_mcp_key_store_concurrent_verify_never_resurrects_revoked_key(tmp_path: Path) -> None:
    store = MCPKeyStore(store_path=tmp_path / "concurrent_keys.json", max_active_keys=50)
    created = store.create_key("Target Key")
    target_id = created["id"]
    target_raw = created["api_key"]
    keep_raw = store.create_key("Sibling Key")["api_key"]

    errors: list[Exception] = []

    def _hammer_verify() -> None:
        try:
            for _ in range(25):
                store.verify_key(target_raw)
                store.verify_key(keep_raw)
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    def _revoke_mid_flight() -> bool:
        return store.revoke_key(target_id)

    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = [pool.submit(_hammer_verify) for _ in range(6)]
        revoked_fut = pool.submit(_revoke_mid_flight)
        create_fut = pool.submit(store.create_key, "Concurrent Created")
        for f in futs:
            f.result()
        assert revoked_fut.result() is True
        extra_raw = create_fut.result()["api_key"]

    assert errors == []
    # Revoked key must NEVER be resurrected; sibling & concurrently created keys must remain intact
    assert store.verify_key(target_raw) is False
    assert store.verify_key(keep_raw) is True
    assert store.verify_key(extra_raw) is True


# ---------------------------------------------------------------------------
# Lead 5: predict-error-path-disclosure
# ---------------------------------------------------------------------------


def test_503_missing_model_does_not_leak_absolute_filesystem_path() -> None:
    _RATE_BUCKETS.clear()
    rng = np.random.default_rng(42)
    _setup_mock_catalog(rng)

    secret_path = r"C:\Users\operator_secret_home\artifacts\models\openrepurpose_winner.joblib"
    with patch.object(
        STATE,
        "ensure_loaded",
        side_effect=FileNotFoundError(f"Model checkpoint not found at {secret_path}"),
    ), patch.object(CATALOG, "ensure_loaded", return_value=None):
        client = TestClient(app, base_url="http://127.0.0.1:8000")

        r_pred = client.post(
            "/api/predict",
            json={"smiles": ASPIRIN_SMILES, "protein_sequence": VALID_SEQUENCE},
        )
        assert r_pred.status_code == 503
        assert "operator_secret_home" not in r_pred.text
        assert "openrepurpose_winner.joblib" not in r_pred.text
        assert "C:\\" not in r_pred.text

        r_mix = client.post(
            "/api/mix",
            json={"drugs": ["Aspirin"], "targets": ["mtb_pknb"]},
        )
        assert r_mix.status_code == 503
        assert "operator_secret_home" not in r_mix.text
        assert "openrepurpose_winner.joblib" not in r_mix.text
        assert "C:\\" not in r_mix.text


# ---------------------------------------------------------------------------
# Lead 6: dataset-download-no-integrity-check
# ---------------------------------------------------------------------------


class _MockStreamResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def raise_for_status(self) -> None:
        return None

    def iter_content(self, chunk_size: int = 1024):
        for i in range(0, len(self._payload), chunk_size):
            yield self._payload[i : i + chunk_size]


def test_dataset_download_integrity_verification_rejects_tampered_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENREPURPOSE_SKIP_DATASET_CHECKSUM", raising=False)
    assert len(PINNED_RAW_DATASET_SHA256) == 5

    valid_bytes = b"Drug\tTarget\tY\nCCO\tMTTPSHLSDRYELGEILGFGG\t6.5\n"
    valid_sha = hashlib.sha256(valid_bytes).hexdigest()
    tampered_bytes = b"Drug\tTarget\tY\nCCO\tMTTPSHLSDRYELGEILGFGG\t99.9\n"

    dest = tmp_path / "fixture_dataset.tab"

    # 1. Tampered download rejected and never written to dest (no leftover temp files)
    with patch("ml.data_loader.requests.get", return_value=_MockStreamResponse(tampered_bytes)):
        with pytest.raises(ValueError, match="integrity check failed"):
            download_verified_file(
                "https://example.invalid/fixture.tab",
                dest,
                expected_sha256=valid_sha,
            )
    assert not dest.exists()
    assert list(tmp_path.iterdir()) == []

    # 2. Oversized payload rejected cleanly
    with patch("ml.data_loader.requests.get", return_value=_MockStreamResponse(b"A" * 2048)):
        with pytest.raises(ValueError, match="exceeded max size"):
            download_verified_file(
                "https://example.invalid/huge.tab",
                dest,
                expected_sha256=valid_sha,
                max_bytes=512,
            )
    assert not dest.exists()
    assert list(tmp_path.iterdir()) == []

    # 3. Matching payload succeeds atomically and returns verified SHA-256
    with patch("ml.data_loader.requests.get", return_value=_MockStreamResponse(valid_bytes)):
        out_path, actual_sha = download_verified_file(
            "https://example.invalid/fixture.tab",
            dest,
            expected_sha256=valid_sha,
        )
    assert out_path == dest
    assert actual_sha == valid_sha
    assert dest.read_bytes() == valid_bytes

    # 4. Tampering with an already-cached local file is caught on subsequent load
    dest.write_bytes(tampered_bytes)
    with pytest.raises(ValueError, match="Cached dataset integrity check failed"):
        download_verified_file(
            "https://example.invalid/fixture.tab",
            dest,
            expected_sha256=valid_sha,
        )
