"""Unit tests for the security-hardened local FastAPI inference server."""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from api.server import STATE, app

VALID_SEQUENCE = (
    "MTTPSHLSDRYELGEILGFGGMSEVHLARDLRLHRDVAVKVLRADLARDPSFYLRFRREAQNAAALNHPAIVAVYDTGEAETPAG"
)
ASPIRIN_SMILES = "CC(=O)Oc1ccccc1C(=O)O"


class _DummyDeterministicModel:
    def predict(self, X: np.ndarray) -> np.ndarray:
        # Deterministic linear function of feature sum for fast offline testing
        base = 6.2 + 0.002 * np.sum(X[:, :16], axis=1)
        return base.astype(np.float64)


def test_health_endpoint_and_security_headers() -> None:
    client = TestClient(app)
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert "status" in body
    assert body["seed"] == 42
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
    assert res.headers.get("X-Frame-Options") == "DENY"
    assert res.headers.get("Cache-Control") == "no-store"


def test_predict_rejects_invalid_smiles_and_metals_and_bad_fasta() -> None:
    client = TestClient(app)

    # Invalid SMILES
    r1 = client.post(
        "/api/predict",
        json={"smiles": "NOT_A_SMILES_@@@", "protein_sequence": VALID_SEQUENCE},
    )
    assert r1.status_code == 422

    # Organometallic platinum salt rejected
    r2 = client.post(
        "/api/predict",
        json={"smiles": "Cl[Pt](Cl)(N)N", "protein_sequence": VALID_SEQUENCE},
    )
    assert r2.status_code == 422

    # Sequence too short (<30 aa)
    r3 = client.post(
        "/api/predict",
        json={"smiles": ASPIRIN_SMILES, "protein_sequence": "ACDEFGHIKLMNPQRSTV"},
    )
    assert r3.status_code == 422

    # Invalid characters in sequence
    r4 = client.post(
        "/api/predict",
        json={"smiles": ASPIRIN_SMILES, "protein_sequence": VALID_SEQUENCE + "12345!"},
    )
    assert r4.status_code == 422


def test_predict_deterministic_end_to_end_with_fasta_header() -> None:
    rng = np.random.default_rng(42)
    fake_emb = {VALID_SEQUENCE: rng.normal(size=(320,)).astype(np.float32)}

    with patch.object(STATE, "ensure_loaded", return_value=None), patch(
        "api.server.extract_protein_embeddings", return_value=fake_emb
    ):
        STATE.loaded = True
        STATE.model = _DummyDeterministicModel()
        STATE.morgan_bit_importances = np.ones((2048,), dtype=np.float64)
        STATE.background_embeddings = rng.normal(size=(32, 320)).astype(np.float32)

        client = TestClient(app)
        fasta_input = f">sp|P9WI81|PKNB_MYCTU\n{VALID_SEQUENCE[:40]}\n{VALID_SEQUENCE[40:]}"
        res1 = client.post(
            "/api/predict",
            json={"smiles": ASPIRIN_SMILES, "protein_sequence": fasta_input, "in_domain": True},
        )
        res2 = client.post(
            "/api/predict",
            json={"smiles": ASPIRIN_SMILES, "protein_sequence": fasta_input, "in_domain": True},
        )

    assert res1.status_code == 200
    assert res2.status_code == 200
    b1, b2 = res1.json(), res2.json()
    assert b1["predicted_pkd"] == b2["predicted_pkd"]
    assert b1["target_selectivity_delta"] == b2["target_selectivity_delta"]
    assert b1["sequence_length"] == len(VALID_SEQUENCE)
    assert "<svg" in (b1["svg_2d"] or "")
    assert "$$$$" in (b1["sdf_3d"] or "")
