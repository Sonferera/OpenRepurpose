"""Rate-limited NCBI PubMed E-utilities novelty checker with transparent verification URLs."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import requests

from ml.config import CACHE_DIR, ensure_directories

logger = logging.getLogger(__name__)

NCBI_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
PUBMED_WEB_SEARCH_BASE = "https://pubmed.ncbi.nlm.nih.gov/?term="


def classify_novelty_tier(pubmed_count: int | None, status: str = "ok") -> tuple[str, str]:
    """Assign transparent novelty tier and display label from verified PubMed hit count."""
    if status != "ok" or pubmed_count is None:
        return "unavailable", "Novelty Unverified (Offline / API Unavailable)"
    if pubmed_count == 0:
        return "unexplored", "Unexplored Hypothesis (0 PubMed hits)"
    if pubmed_count <= 5:
        return "emerging", f"Emerging Signal ({pubmed_count} PubMed {'hit' if pubmed_count == 1 else 'hits'})"
    return "supported", f"Literature Supported ({pubmed_count} PubMed hits)"


def build_pubmed_query(drug_name: str, disease_terms: str) -> str:
    clean_drug = drug_name.strip().replace('"', "")
    clean_disease = disease_terms.strip()
    return f'"{clean_drug}"[Title/Abstract] AND ({clean_disease})'


def build_pubmed_web_url(query: str) -> str:
    return f"{PUBMED_WEB_SEARCH_BASE}{quote_plus(query)}"


class PubMedNoveltyChecker:
    """Rate-limited (<= 3 req/sec) NCBI PubMed E-utilities client with local disk caching."""

    def __init__(
        self,
        cache_path: Path | None = None,
        min_interval_sec: float | None = None,
        timeout_sec: float = 15.0,
    ) -> None:
        ensure_directories()
        self.cache_path = cache_path or (CACHE_DIR / "pubmed_cache.json")
        self.email = os.getenv("NCBI_EMAIL", "").strip()
        self.api_key = os.getenv("NCBI_API_KEY", "").strip()
        # NCBI guideline: <= 3 req/s without key (0.38s safe spacing), <= 10 req/s with key
        default_interval = 0.12 if self.api_key else 0.38
        self.min_interval_sec = float(min_interval_sec if min_interval_sec is not None else default_interval)
        self.timeout_sec = float(timeout_sec)
        self._last_request_ts: float = 0.0
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": "OpenRepurpose/0.1 (Pre-clinical NTD Drug Repurposing)"})
        self._cache: dict[str, dict[str, Any]] = self._load_cache()
        self._dirty: bool = False

    def _load_cache(self) -> dict[str, dict[str, Any]]:
        if not self.cache_path.exists():
            return {}
        try:
            return json.loads(self.cache_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def save_cache(self) -> None:
        if not self._dirty:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_path.with_suffix(".tmp.json")
        tmp.write_text(json.dumps(self._cache, indent=2), encoding="utf-8")
        os.replace(tmp, self.cache_path)
        self._dirty = False

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request_ts
        if elapsed < self.min_interval_sec:
            time.sleep(self.min_interval_sec - elapsed)
        self._last_request_ts = time.monotonic()

    def check(self, drug_name: str, disease_terms: str, offline: bool = False) -> dict[str, Any]:
        """Query PubMed for co-occurrence of drug_name and disease_terms with full provenance."""
        query = build_pubmed_query(drug_name, disease_terms)
        web_url = build_pubmed_web_url(query)

        cached = self._cache.get(query)
        if cached and cached.get("status") == "ok":
            return dict(cached)

        if offline:
            tier, label = classify_novelty_tier(None, status="unavailable")
            return {
                "status": "unavailable",
                "pubmed_count": None,
                "novelty_tier": tier,
                "novelty_label": label,
                "query": query,
                "pubmed_url": web_url,
                "sample_pmids": [],
            }

        params: dict[str, Any] = {
            "db": "pubmed",
            "retmode": "json",
            "retmax": 3,
            "term": query,
        }
        if self.email:
            params["email"] = self.email
        if self.api_key:
            params["api_key"] = self.api_key

        last_err: Exception | None = None
        for attempt in range(3):
            self._throttle()
            try:
                resp = self._session.get(NCBI_ESEARCH_URL, params=params, timeout=self.timeout_sec)
                if resp.status_code == 429:
                    time.sleep(1.0 * (attempt + 1))
                    continue
                resp.raise_for_status()
                payload = resp.json()
                esearch = payload.get("esearchresult") or {}
                count_raw = esearch.get("count")
                if count_raw is None:
                    raise ValueError(f"Missing count in PubMed response: {payload}")
                count = int(count_raw)
                pmids = [str(p) for p in (esearch.get("idlist") or [])[:3]]
                tier, label = classify_novelty_tier(count, status="ok")
                record = {
                    "status": "ok",
                    "pubmed_count": count,
                    "novelty_tier": tier,
                    "novelty_label": label,
                    "query": query,
                    "pubmed_url": web_url,
                    "sample_pmids": pmids,
                }
                self._cache[query] = record
                self._dirty = True
                return dict(record)
            except Exception as exc:
                last_err = exc
                time.sleep(0.6 * (attempt + 1))

        logger.warning("PubMed query failed for %r (%s); tagging unavailable.", query, last_err)
        tier, label = classify_novelty_tier(None, status="unavailable")
        return {
            "status": "unavailable",
            "pubmed_count": None,
            "novelty_tier": tier,
            "novelty_label": label,
            "query": query,
            "pubmed_url": web_url,
            "sample_pmids": [],
        }
