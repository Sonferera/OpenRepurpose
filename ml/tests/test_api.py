"""Unit tests for the security-hardened local FastAPI inference, Full-DB catalog, and Mix API."""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from api.catalog import CATALOG, DrugCatalogItem, TargetCatalogItem
from api.server import STATE, _RATE_BUCKETS, app
from ml.chem_filters import get_bemis_murcko_scaffold, parse_and_canonicalize
from ml.ddi_data_loader import make_canonical_pair_key
from ml.features import sequence_sha256
from ml.splits import smiles_to_inchikey14

VALID_SEQUENCE = (
    "MTTPSHLSDRYELGEILGFGGMSEVHLARDLRLHRDVAVKVLRADLARDPSFYLRFRREAQNAAALNHPAIVAVYDTGEAETPAG"
)
VALID_SEQUENCE_2 = (
    "MGCSQSSNVKDFKTRRSKFTNGNNYGKSGNNKNSEDLAINPGMYVRKKEGKIGESYFKVRKLGSGAYGEVLLCREKHGHGEKAIKV"
)
ASPIRIN_SMILES = "CC(=O)Oc1ccccc1C(=O)O"
IMATINIB_SMILES = "Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1"


class _DummyDeterministicModel:
    def predict(self, X: np.ndarray) -> np.ndarray:
        # Deterministic linear function of feature sum for fast offline testing
        base = 6.2 + 0.002 * np.sum(X[:, :16], axis=1)
        return base.astype(np.float64)


class _DummySymmetricDDIModel:
    def predict_smiles_pairs(self, smiles_pairs: list[tuple[str, str]]) -> list[dict[str, object]]:
        out = []
        for sa, sb in smiles_pairs:
            # Order-invariant deterministic mock score
            pair_len = len(sa) + len(sb)
            prob = round(min(0.95, 0.25 + (pair_len % 50) / 100.0), 4)
            out.append(
                {
                    "ddi_probability": prob,
                    "risk_tier": "moderate_predicted_risk" if prob >= 0.5 else "low_predicted_risk",
                    "risk_label": "Mock DDI Score",
                    "predicted_category": "pk_concentration_increase",
                    "predicted_category_label": "PK Exposure Increase",
                    "category_confidence": 0.72,
                    "threshold_used": 0.5,
                    "model_key": "ddi_mock",
                }
            )
        return out


def _setup_mock_catalog(rng: np.random.Generator) -> None:
    _, asp_canon = parse_and_canonicalize(ASPIRIN_SMILES)
    _, ima_canon = parse_and_canonicalize(IMATINIB_SMILES)
    assert asp_canon is not None and ima_canon is not None

    d1 = DrugCatalogItem(
        id="FDA_ASPIRIN",
        name="Aspirin",
        canonical_smiles=asp_canon,
        scaffold_smiles=get_bemis_murcko_scaffold(asp_canon),
        source="fda_approved",
        moa="COX inhibitor",
        known_indication="analgesic; antiplatelet",
        n_experimental_assays=3,
    )
    d2 = DrugCatalogItem(
        id="FDA_IMATINIB",
        name="Imatinib",
        canonical_smiles=ima_canon,
        scaffold_smiles=get_bemis_murcko_scaffold(ima_canon),
        source="fda_approved",
        moa="BCR-ABL tyrosine kinase inhibitor",
        known_indication="chronic myeloid leukemia",
        n_experimental_assays=12,
    )
    t1 = TargetCatalogItem(
        id="mtb_pknb",
        name="M. tuberculosis PknB Kinase",
        short_name="Mtb PknB",
        sequence=VALID_SEQUENCE,
        sequence_length=len(VALID_SEQUENCE),
        sequence_sha256=sequence_sha256(VALID_SEQUENCE),
        in_domain=True,
        source="curated_ntd",
        disease="Tuberculosis",
        pathogen="Mycobacterium tuberculosis",
        uniprot_id="P9WI81",
        n_experimental_assays=20,
    )
    t2 = TargetCatalogItem(
        id="pf_cdpk1",
        name="P. falciparum PfCDPK1 Kinase",
        short_name="PfCDPK1",
        sequence=VALID_SEQUENCE_2,
        sequence_length=len(VALID_SEQUENCE_2),
        sequence_sha256=sequence_sha256(VALID_SEQUENCE_2),
        in_domain=True,
        source="curated_ntd",
        disease="Malaria",
        pathogen="Plasmodium falciparum",
        uniprot_id="P62344",
        n_experimental_assays=15,
    )

    CATALOG.loaded = True
    CATALOG.drugs = [d1, d2]
    CATALOG.targets = [t1, t2]
    CATALOG._drug_by_id = {d.id.lower(): d for d in CATALOG.drugs}
    CATALOG._drug_by_name_lower = {d.name.lower(): d for d in CATALOG.drugs}
    CATALOG._drug_by_smiles = {d.canonical_smiles: d for d in CATALOG.drugs}
    CATALOG._target_by_id = {t.id.lower(): t for t in CATALOG.targets}
    CATALOG._target_by_name_lower = {t.name.lower(): t for t in CATALOG.targets}
    CATALOG._target_by_uniprot_lower = {t.uniprot_id.lower(): t for t in CATALOG.targets}
    CATALOG._target_by_seq = {t.sequence: t for t in CATALOG.targets}
    CATALOG._exp_kd_lookup = {
        (ima_canon, VALID_SEQUENCE): {
            "pkd": 7.85,
            "kd_nm": 14.13,
            "drug_id": "FDA_IMATINIB",
            "target_id": "mtb_pknb",
            "source": "combined_kd_clean (mock)",
        }
    }
    CATALOG._protein_emb_cache = {
        t1.sequence_sha256: rng.normal(size=(320,)).astype(np.float32),
        t2.sequence_sha256: rng.normal(size=(320,)).astype(np.float32),
    }
    ik_pair = make_canonical_pair_key(smiles_to_inchikey14(asp_canon), smiles_to_inchikey14(ima_canon))
    CATALOG._ddi_lookup = {
        ik_pair: {
            "y_class": 47,
            "risk_category": "toxicity_adverse",
            "risk_label": "Toxicity / Adverse Event Risk",
            "description": "The risk or severity of bleeding can be increased when Drug A is combined with Drug B.",
            "drug_a_id": "DB00945",
            "drug_b_id": "DB00619",
        }
    }
    CATALOG.stats = {
        "n_curated_targets": 2,
        "n_fda_drugs": 2,
        "n_experimental_compounds": 0,
        "n_experimental_targets": 0,
        "n_total_drugs": 2,
        "n_total_targets": 2,
        "n_experimental_kd_pairs": 1,
        "n_cached_protein_embeddings": 2,
        "n_known_ddi_pairs": 1,
    }


def test_health_endpoint_and_security_headers() -> None:
    _RATE_BUCKETS.clear()
    client = TestClient(app)
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert "status" in body
    assert body["seed"] == 42
    assert "ddi_model_loaded" in body
    assert "catalog_ready" in body
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
    assert res.headers.get("X-Frame-Options") == "DENY"
    assert res.headers.get("Cache-Control") == "no-store"


def test_predict_rejects_invalid_smiles_and_metals_and_bad_fasta() -> None:
    _RATE_BUCKETS.clear()
    client = TestClient(app)

    r1 = client.post(
        "/api/predict",
        json={"smiles": "NOT_A_SMILES_@@@", "protein_sequence": VALID_SEQUENCE},
    )
    assert r1.status_code == 422

    r2 = client.post(
        "/api/predict",
        json={"smiles": "Cl[Pt](Cl)(N)N", "protein_sequence": VALID_SEQUENCE},
    )
    assert r2.status_code == 422

    r3 = client.post(
        "/api/predict",
        json={"smiles": ASPIRIN_SMILES, "protein_sequence": "ACDEFGHIKLMNPQRSTV"},
    )
    assert r3.status_code == 422

    r4 = client.post(
        "/api/predict",
        json={"smiles": ASPIRIN_SMILES, "protein_sequence": VALID_SEQUENCE + "12345!"},
    )
    assert r4.status_code == 422


def test_predict_deterministic_end_to_end_with_fasta_header() -> None:
    _RATE_BUCKETS.clear()
    rng = np.random.default_rng(42)
    fake_emb = {VALID_SEQUENCE: rng.normal(size=(320,)).astype(np.float32)}

    with patch.object(STATE, "ensure_loaded", return_value=None), patch.object(
        CATALOG, "loaded", False
    ), patch("api.server.extract_protein_embeddings", return_value=fake_emb):
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


def test_catalog_search_and_mix_endpoint_ground_truth_and_ddi_symmetry() -> None:
    _RATE_BUCKETS.clear()
    rng = np.random.default_rng(42)
    _setup_mock_catalog(rng)

    with patch.object(STATE, "ensure_loaded", return_value=None), patch.object(
        STATE, "ensure_ddi_loaded", return_value=True
    ), patch.object(CATALOG, "ensure_loaded", return_value=None):
        STATE.loaded = True
        STATE.model = _DummyDeterministicModel()
        STATE.morgan_bit_importances = np.ones((2048,), dtype=np.float64)
        STATE.background_embeddings = rng.normal(size=(32, 320)).astype(np.float32)
        STATE.ddi_loaded = True
        STATE.ddi_predictor = _DummySymmetricDDIModel()
        STATE.ddi_winner_key = "ddi_mock"

        client = TestClient(app)

        # 1. Search drugs & targets
        s_drug = client.get("/api/catalog/search", params={"q": "imat", "kind": "drugs"})
        assert s_drug.status_code == 200
        assert s_drug.headers.get("X-Frame-Options") == "DENY"
        assert len(s_drug.json()["drugs"]) == 1
        assert s_drug.json()["drugs"][0]["id"] == "FDA_IMATINIB"

        s_tgt = client.get("/api/catalog/search", params={"q": "malaria", "kind": "targets"})
        assert s_tgt.status_code == 200
        assert s_tgt.json()["targets"][0]["id"] == "pf_cdpk1"

        # 2. Composite mix: 2 drugs x 2 targets (order A,B vs order B,A)
        r_ab = client.post(
            "/api/mix",
            json={
                "drugs": ["Aspirin", "FDA_IMATINIB"],
                "targets": ["mtb_pknb", "pf_cdpk1"],
                "include_structures": True,
            },
        )
        r_ba = client.post(
            "/api/mix",
            json={
                "drugs": ["FDA_IMATINIB", "Aspirin"],
                "targets": ["mtb_pknb", "pf_cdpk1"],
                "include_structures": False,
            },
        )
        assert r_ab.status_code == 200
        assert r_ba.status_code == 200
        body_ab = r_ab.json()
        body_ba = r_ba.json()

        # Transparent separation: 2x2 = 4 drug-target entries + 1 pairwise DDI entry
        assert len(body_ab["drug_target_matrix"]) == 4
        assert len(body_ab["ddi_pairs"]) == 1

        # Ground truth experimental Kd detected on Imatinib x mtb_pknb
        ima_pknb = [
            cell
            for cell in body_ab["drug_target_matrix"]
            if cell["drug_id"] == "FDA_IMATINIB" and cell["target_id"] == "mtb_pknb"
        ][0]
        assert ima_pknb["evaluation_mode"] == "experimental_ground_truth"
        assert ima_pknb["experimental_ground_truth"]["matched"] is True
        assert ima_pknb["experimental_ground_truth"]["pkd"] == 7.85

        # Known DrugBank DDI matched & model DDI score strictly symmetric
        ddi_ab = body_ab["ddi_pairs"][0]
        ddi_ba = body_ba["ddi_pairs"][0]
        assert ddi_ab["known_in_drugbank"] is True
        assert ddi_ba["known_in_drugbank"] is True
        assert ddi_ab["model_prediction"]["ddi_probability"] == ddi_ba["model_prediction"]["ddi_probability"]
        assert "svg_2d" in body_ab["drugs"][0] and "<svg" in (body_ab["drugs"][0]["svg_2d"] or "")
        assert "clinical_disclaimer" in body_ab["provenance"]


def test_mix_validation_rejects_bad_inputs_and_over_limits() -> None:
    _RATE_BUCKETS.clear()
    rng = np.random.default_rng(42)
    _setup_mock_catalog(rng)

    with patch.object(STATE, "ensure_loaded", return_value=None), patch.object(
        STATE, "ensure_ddi_loaded", return_value=False
    ), patch.object(CATALOG, "ensure_loaded", return_value=None):
        STATE.loaded = True
        STATE.model = _DummyDeterministicModel()
        STATE.background_embeddings = rng.normal(size=(8, 320)).astype(np.float32)

        client = TestClient(app)

        # Too many drugs (>4)
        r_many = client.post(
            "/api/mix",
            json={"drugs": ["Aspirin"] * 5, "targets": ["mtb_pknb"]},
        )
        assert r_many.status_code == 422

        # Too many targets (>2)
        r_many_t = client.post(
            "/api/mix",
            json={"drugs": ["Aspirin"], "targets": ["mtb_pknb", "pf_cdpk1", VALID_SEQUENCE]},
        )
        assert r_many_t.status_code == 422

        # Inorganic metal salt rejected
        r_metal = client.post(
            "/api/mix",
            json={"drugs": ["Cl[Pt](Cl)(N)N"], "targets": ["mtb_pknb"]},
        )
        assert r_metal.status_code == 422

        # Invalid target rejected
        r_bad_t = client.post(
            "/api/mix",
            json={"drugs": ["Aspirin"], "targets": ["UNKNOWN_TARGET_XYZ"]},
        )
        assert r_bad_t.status_code == 422
