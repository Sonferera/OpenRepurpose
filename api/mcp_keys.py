"""Local API key store for authenticating OpenRepurpose Remote Streamable HTTP MCP clients.

Security properties:
  - Generates 192-bit random tokens prefixed with `orp_live_` via `secrets.token_hex(24)`.
  - Persists ONLY SHA-256 hashes (never plaintext tokens) in `artifacts/cache/mcp_api_keys.json`.
  - Supports constant-time verification via `hmac.compare_digest`, optional `OPENREPURPOSE_MCP_API_KEY`
    env override for headless/cloud deployments, and instant key revocation.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from ml.config import CACHE_DIR, ensure_directories

MCP_KEYS_PATH: Path = CACHE_DIR / "mcp_api_keys.json"
KEY_PREFIX = "orp_live_"
DEFAULT_MAX_ACTIVE_KEYS = 50


def _hash_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MCPKeyStore:
    """Thread-safe & process-locked JSON-backed hashed API key store for MCP access."""

    def __init__(
        self,
        store_path: Path | None = None,
        max_active_keys: int | None = None,
    ) -> None:
        self.store_path = store_path or MCP_KEYS_PATH
        self.max_active_keys = (
            max_active_keys
            if max_active_keys is not None
            else int(os.getenv("MCP_MAX_ACTIVE_KEYS", str(DEFAULT_MAX_ACTIVE_KEYS)))
        )
        self._lock = threading.RLock()

    @contextmanager
    def _locked_store(self) -> Iterator[None]:
        """Acquire both an in-process RLock and an OS-level lockfile around store I/O."""
        with self._lock:
            self.store_path.parent.mkdir(parents=True, exist_ok=True)
            lock_path = self.store_path.with_suffix(".lock")
            lock_fh = open(lock_path, "a+b")
            try:
                if os.name == "nt":
                    import msvcrt

                    lock_fh.seek(0)
                    # Ensure at least 1 byte exists for Windows byte-range locking
                    if lock_fh.tell() == 0 and lock_path.stat().st_size == 0:
                        lock_fh.write(b"\0")
                        lock_fh.flush()
                    lock_fh.seek(0)
                    msvcrt.locking(lock_fh.fileno(), msvcrt.LK_LOCK, 1)
                else:
                    import fcntl

                    fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
                yield
            finally:
                try:
                    if os.name == "nt":
                        import msvcrt

                        lock_fh.seek(0)
                        msvcrt.locking(lock_fh.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
                finally:
                    lock_fh.close()

    def _read_records(self) -> list[dict[str, Any]]:
        if not self.store_path.exists():
            return []
        try:
            raw = json.loads(self.store_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                return raw
        except Exception:
            pass
        return []

    def _write_records(self, records: list[dict[str, Any]]) -> None:
        ensure_directories()
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            dir=str(self.store_path.parent),
            prefix=f".{self.store_path.stem}_",
            suffix=".tmp.json",
        )
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(records, indent=2))
                fh.flush()
                os.fsync(fh.fileno())
            if os.name != "nt":
                os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, self.store_path)
        except Exception:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def create_key(self, label: str = "Default AI Client") -> dict[str, Any]:
        """Generate a new API key, store its SHA-256 hash, and return the raw key once."""
        clean_label = str(label or "AI Client").strip()[:64] or "AI Client"
        raw_secret = f"{KEY_PREFIX}{secrets.token_hex(24)}"
        key_id = f"key_{secrets.token_hex(6)}"
        now = _utc_now()

        record = {
            "id": key_id,
            "label": clean_label,
            "prefix": f"{raw_secret[:15]}...",
            "sha256": _hash_key(raw_secret),
            "created_at_utc": now,
            "last_used_at_utc": None,
            "revoked": False,
        }
        with self._locked_store():
            records = self._read_records()
            active_count = sum(1 for r in records if not bool(r.get("revoked", False)))
            if active_count >= self.max_active_keys:
                raise ValueError(
                    f"Active MCP key limit reached ({self.max_active_keys}). "
                    "Revoke an unused key before generating a new one."
                )
            records.append(record)
            self._write_records(records)

        return {
            "id": key_id,
            "label": clean_label,
            "prefix": record["prefix"],
            "api_key": raw_secret,  # Returned once on creation
            "created_at_utc": now,
        }

    def list_keys(self) -> list[dict[str, Any]]:
        """List all non-revoked key metadata (never exposes secrets or hashes)."""
        with self._locked_store():
            records = self._read_records()
        return [
            {
                "id": str(r["id"]),
                "label": str(r.get("label", "AI Client")),
                "prefix": str(r.get("prefix", "orp_live_...")),
                "created_at_utc": r.get("created_at_utc"),
                "last_used_at_utc": r.get("last_used_at_utc"),
            }
            for r in records
            if not bool(r.get("revoked", False))
        ]

    def revoke_key(self, key_id: str) -> bool:
        """Revoke an active key by ID atomically. Returns True if found and revoked."""
        with self._locked_store():
            records = self._read_records()
            changed = False
            for rec in records:
                if str(rec.get("id")) == str(key_id) and not bool(rec.get("revoked", False)):
                    rec["revoked"] = True
                    rec["revoked_at_utc"] = _utc_now()
                    changed = True
                    break
            if changed:
                self._write_records(records)
            return changed

    def verify_key(self, candidate: str, *, update_last_used: bool = True) -> bool:
        """Validate candidate token against env override or stored active SHA-256 hashes."""
        token = str(candidate or "").strip()
        if not token:
            return False

        env_key = os.getenv("OPENREPURPOSE_MCP_API_KEY", "").strip()
        if env_key and hmac.compare_digest(token, env_key):
            return True

        cand_hash = _hash_key(token)
        with self._locked_store():
            records = self._read_records()
            matched_idx: int | None = None
            for idx, rec in enumerate(records):
                if bool(rec.get("revoked", False)):
                    continue
                stored_hash = str(rec.get("sha256", ""))
                if stored_hash and hmac.compare_digest(cand_hash, stored_hash):
                    matched_idx = idx
                    break

            if matched_idx is not None:
                if update_last_used:
                    records[matched_idx]["last_used_at_utc"] = _utc_now()
                    try:
                        self._write_records(records)
                    except Exception:
                        pass
                return True

        return False


MCP_KEY_STORE = MCPKeyStore()
