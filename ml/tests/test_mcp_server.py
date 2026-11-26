"""Offline smoke tests for OpenRepurpose MCP Server tools and catalog name/synonym normalization."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from api.catalog import (
    CATALOG,
    DrugCatalogItem,
    FullDBCatalog,
    TargetCatalogItem,
    normalize_drug_name_key,
)
from api.mcp_server import (
    create_mcp_server,
    tool_check_drug_pair_ddi,
    tool_check_pubmed_novelty,
    tool_evaluate_regimen_mix,
    tool_get_precomputed_candidates,
    tool_list_targets_and_search_db,
    tool_score_drug_target,
)
from api.services import _InferenceState
from ml.chem_filters import get_bemis_murcko_scaffold, parse_and_canonicalize
from ml.ddi_data_loader import make_canonical_pair_key
from ml.features import sequence_sha256
from ml.novelty import PubMedNoveltyChecker
from ml.splits import smiles_to_inchikey14

VALID_SEQ = (
    "MTTPSHLSDRYELGEILGFGGMSEVHLARDLRLHRDVAVKVLRADLARDPSFYLRFRREAQNAAALNHPAIVAVYDTGEAETPAG"
)
PARACETAMOL_SMILES = "CC(=O)Nc1ccc(O)cc1"
ISOSORBIDE_MONO_SMILES = "O=[N+]([O-])O[C@@H]1CO[C@H]2[C@@H]1OC[C@H]2O"
WARFARIN_SMILES = "CC(=O)CC(c1ccccc1)c1c(O)c2ccccc2oc1=O"


class _MockDTIModel:
    def predict(self, X: np.ndarray) -> np.ndarray:
        return (6.5 + 0.001 * np.sum(X[:, :16], axis=1)).astype(np.float64)


class _MockDDIModel:
    def predict_smiles_pairs(self, smiles_pairs: list[tuple[str, str]]) -> list[dict[str, object]]:
        out = []
        for sa, sb in smiles_pairs:
            p = round(min(0.95, 0.30 + ((len(sa) + len(sb)) % 40) / 100.0), 4)
            out.append(
                {
                    "ddi_probability": p,
                    "risk_tier": "moderate_predicted_risk" if p >= 0.5 else "low_predicted_risk",
                    "risk_label": "Mock DDI Risk",
                    "predicted_category": "toxicity_adverse",
                    "predicted_category_label": "Toxicity / Adverse Event Risk",
                    "category_confidence": 0.81,
                    "threshold_used": 0.5,
                    "model_key": "ddi_mock",
                }
            )
        return out


def _build_offline_fixture(rng: np.random.Generator) -> tuple[_InferenceState, FullDBCatalog]:
    _, para_c = parse_and_canonicalize(PARACETAMOL_SMILES)
    _, iso_c = parse_and_canonicalize(ISOSORBIDE_MONO_SMILES)
    _, warf_c = parse_and_canonicalize(WARFARIN_SMILES)
    assert para_c and iso_c and warf_c

    d_para = DrugCatalogItem(
        id="FDA_PARA",
        name="Paracetamol",
        canonical_smiles=para_c,
        scaffold_smiles=get_bemis_murcko_scaffold(para_c),
        source="fda_approved",
        moa="Analgesic",
        known_indication="pain; fever",
    )
    d_iso = DrugCatalogItem(
        id="FDA_ISO_MONO",
        name="Isosorbide-mononitrate",
        canonical_smiles=iso_c,
        scaffold_smiles=get_bemis_murcko_scaffold(iso_c),
        source="fda_approved",
        moa="Nitrate vasodilator",
        known_indication="angina",
    )
    d_warf = DrugCatalogItem(
        id="FDA_WARF",
        name="Warfarin",
        canonical_smiles=warf_c,
        scaffold_smiles=get_bemis_murcko_scaffold(warf_c),
        source="fda_approved",
        moa="Vitamin K antagonist",
        known_indication="anticoagulant",
    )
    t1 = TargetCatalogItem(
        id="mtb_pknb",
        name="M. tuberculosis PknB Kinase",
        short_name="Mtb PknB",
        sequence=VALID_SEQ,
        sequence_length=len(VALID_SEQ),
        sequence_sha256=sequence_sha256(VALID_SEQ),
        in_domain=True,
        source="curated_ntd",
        disease="Tuberculosis",
        uniprot_id="P9WI81",
    )

    cat = FullDBCatalog()
    cat.loaded = True
    cat.drugs = [d_para, d_iso, d_warf]
    cat.targets = [t1]
    cat._drug_by_id = {d.id.lower(): d for d in cat.drugs}
    cat._drug_by_id["db00316"] = d_para  # DrugBank alias test
    cat._drug_by_name_lower = {d.name.lower(): d for d in cat.drugs}
    cat._drug_by_norm_name = {
        normalize_drug_name_key(d.name): d for d in cat.drugs
    }
    cat._drug_by_norm_name["acetaminophen"] = d_para
    cat._drug_by_smiles = {d.canonical_smiles: d for d in cat.drugs}
    cat._target_by_id = {t1.id.lower(): t1}
    cat._target_by_name_lower = {t1.name.lower(): t1}
    cat._target_by_uniprot_lower = {t1.uniprot_id.lower(): t1}
    cat._target_by_seq = {t1.sequence: t1}
    cat._protein_emb_cache = {t1.sequence_sha256: rng.normal(size=(320,)).astype(np.float32)}
    cat._exp_kd_lookup = {
        (warf_c, VALID_SEQ): {
            "pkd": 7.12,
            "kd_nm": 75.86,
            "drug_id": "FDA_WARF",
            "target_id": "mtb_pknb",
            "source": "combined_kd_clean (mock)",
        }
    }
    cat._ddi_lookup = {
        make_canonical_pair_key(smiles_to_inchikey14(para_c), smiles_to_inchikey14(warf_c)): {
            "y_class": 12,
            "risk_category": "pd_synergy_potentiation",
            "risk_label": "Pharmacodynamic Potentiation",
            "description": "Drug A may increase anticoagulant effect of Drug B.",
            "drug_a_id": "DB00316",
            "drug_b_id": "DB00682",
        }
    }
    cat.stats = {"n_total_drugs": 3, "n_total_targets": 1}

    st = _InferenceState()
    st.loaded = True
    st.model = _MockDTIModel()
    st.winner_key = "openrepurpose_mock"
    st.morgan_bit_importances = np.ones((2048,), dtype=np.float64)
    st.background_embeddings = rng.normal(size=(16, 320)).astype(np.float32)
    st.ddi_loaded = True
    st.ddi_predictor = _MockDDIModel()
    st.ddi_winner_key = "ddi_mock"
    return st, cat


def _assert_provenance(payload: dict) -> None:
    prov = payload.get("provenance")
    assert isinstance(prov, dict)
    for req_key in ("model_key", "seed", "experimental_vs_predicted", "in_domain", "clinical_disclaimer"):
        assert req_key in prov, f"Missing provenance field {req_key!r}"
    assert prov["seed"] == 42
    assert len(str(prov["clinical_disclaimer"])) > 20


def test_catalog_name_normalization_and_synonyms() -> None:
    rng = np.random.default_rng(42)
    _, cat = _build_offline_fixture(rng)

    # Space vs hyphen normalization
    d1, _ = cat.resolve_drug("Isosorbide mononitrate")
    assert d1.name == "Isosorbide-mononitrate"

    # Exact INN/USAN synonym resolution
    d2, _ = cat.resolve_drug("Acetaminophen")
    assert d2.name == "Paracetamol"

    # DrugBank ID alias resolution
    d3, _ = cat.resolve_drug("DB00316")
    assert d3.name == "Paracetamol"

    # Search matches synonym cleanly
    sr = tool_list_targets_and_search_db(query="acetaminophen", kind="drugs", catalog=cat)
    assert len(sr["drugs"]) == 1
    assert sr["drugs"][0]["name"] == "Paracetamol"
    _assert_provenance(sr)


def test_all_six_mcp_tool_functions_offline(tmp_path: Path) -> None:
    rng = np.random.default_rng(42)
    st, cat = _build_offline_fixture(rng)

    # 1. list_targets_and_search_db
    r1 = tool_list_targets_and_search_db(query="tuberculosis", kind="targets", catalog=cat)
    assert len(r1["targets"]) == 1
    _assert_provenance(r1)

    # 2. get_precomputed_candidates
    mock_screening = {
        "model_key": "openrepurpose_ensemble",
        "generated_at_utc": "2026-11-26T00:00:00Z",
        "target": {"id": "mtb_pknb", "name": "Mtb PknB", "disease": "Tuberculosis", "in_domain": True},
        "candidates": [
            {
                "drug_id": "D1",
                "drug_name": "CleanNovelDrug",
                "canonical_smiles": PARACETAMOL_SMILES,
                "rank": 1,
                "rank_by_selectivity": 1,
                "predicted_pkd": 7.4,
                "estimated_kd_nm": 39.8,
                "target_selectivity_delta": 0.65,
                "specificity_tier": "high",
                "in_training_corpus": False,
                "medchem": {"ro5_violations": 0, "has_pains": False, "qed": 0.72},
                "novelty": {"pubmed_count": 0},
                "triage_gates": {"overall_status": "PASS"},
            },
            {
                "drug_id": "D2",
                "drug_name": "PainsDrug",
                "canonical_smiles": WARFARIN_SMILES,
                "rank": 2,
                "rank_by_selectivity": 2,
                "predicted_pkd": 7.1,
                "estimated_kd_nm": 79.4,
                "target_selectivity_delta": 0.3,
                "specificity_tier": "moderate",
                "in_training_corpus": True,
                "medchem": {"ro5_violations": 2, "has_pains": True, "qed": 0.4},
                "novelty": {"pubmed_count": 12},
                "triage_gates": {"overall_status": "FAIL"},
            },
        ],
    }
    (tmp_path / "mtb_pknb.json").write_text(json.dumps(mock_screening), encoding="utf-8")
    r2 = tool_get_precomputed_candidates(
        "mtb_pknb", novel_only=True, ro5_only=True, no_pains=True, limit=5, screening_dir=tmp_path
    )
    assert r2["n_matched"] == 1
    assert r2["candidates"][0]["drug_name"] == "CleanNovelDrug"
    _assert_provenance(r2)

    # 3. score_drug_target (compact JSON, no SVG/SDF bloat)
    r3 = tool_score_drug_target("Warfarin", "mtb_pknb", state=st, catalog=cat)
    assert r3["experimental_ground_truth"]["matched"] is True
    assert "svg_2d" not in r3 and "sdf_3d" not in r3
    assert r3["provenance"]["experimental_vs_predicted"] == "experimental_ground_truth"
    _assert_provenance(r3)

    # 4. check_drug_pair_ddi (symmetry + known DrugBank detection)
    r4_ab = tool_check_drug_pair_ddi("Acetaminophen", "Warfarin", state=st, catalog=cat)
    r4_ba = tool_check_drug_pair_ddi("Warfarin", "Paracetamol", state=st, catalog=cat)
    assert r4_ab["known_in_drugbank"] is True
    assert r4_ab["model_prediction"]["ddi_probability"] == r4_ba["model_prediction"]["ddi_probability"]
    _assert_provenance(r4_ab)

    # 5. evaluate_regimen_mix
    r5 = tool_evaluate_regimen_mix(["Acetaminophen", "Warfarin"], ["mtb_pknb"], state=st, catalog=cat)
    assert len(r5["drug_target_matrix"]) == 2
    assert len(r5["ddi_pairs"]) == 1
    assert r5["ddi_pairs"][0]["known_in_drugbank"] is True
    _assert_provenance(r5)

    # 6. check_pubmed_novelty (offline safe)
    checker = PubMedNoveltyChecker(cache_path=tmp_path / "pubmed_cache.json")
    r6 = tool_check_pubmed_novelty("Imatinib", '"tuberculosis"[Title/Abstract]', offline=True, checker=checker)
    assert r6["status"] == "unavailable"
    assert "pubmed.ncbi.nlm.nih.gov" in r6["pubmed_url"]
    _assert_provenance(r6)


def test_fastmcp_server_registers_all_six_tools() -> None:
    mcp_pkg = pytest.importorskip("mcp")
    assert mcp_pkg is not None
    server = create_mcp_server()
    tools = asyncio.run(server.list_tools())
    tool_names = {t.name for t in tools}
    assert tool_names == {
        "list_targets_and_search_db",
        "get_precomputed_candidates",
        "score_drug_target",
        "check_drug_pair_ddi",
        "evaluate_regimen_mix",
        "check_pubmed_novelty",
    }


def test_http_mcp_key_lifecycle_and_streamable_http_auth(tmp_path: Path) -> None:
    pytest.importorskip("mcp")
    from fastapi.testclient import TestClient

    from api.mcp_keys import MCPKeyStore
    from api.server import app

    isolated_store = MCPKeyStore(store_path=tmp_path / "mcp_keys.json")
    init_rpc = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "pytest-client", "version": "1.0"},
        },
    }
    list_rpc = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}

    with patch("api.server.MCP_KEY_STORE", isolated_store):
        with TestClient(app) as client:
            # 1. Unauthenticated /mcp rejected with 401
            r_unauth = client.post(
                "/mcp",
                json=init_rpc,
                headers={"Accept": "application/json, text/event-stream"},
            )
            assert r_unauth.status_code == 401

            # 2. Create API key via /api/mcp/keys (Stitch-style)
            r_create = client.post("/api/mcp/keys", json={"label": "Cursor Test"})
            assert r_create.status_code == 200
            created = r_create.json()
            raw_key = created["api_key"]
            key_id = created["id"]
            assert raw_key.startswith("orp_live_")

            # List keys never exposes plaintext secret
            r_list = client.get("/api/mcp/keys")
            assert r_list.status_code == 200
            assert len(r_list.json()["keys"]) == 1
            assert raw_key not in r_list.text

            # 3. Authenticated Streamable HTTP MCP works with X-API-Key AND Authorization: Bearer
            r_init = client.post(
                "/mcp",
                json=init_rpc,
                headers={
                    "Accept": "application/json, text/event-stream",
                    "X-API-Key": raw_key,
                },
            )
            assert r_init.status_code == 200, r_init.text
            assert "OpenRepurpose" in r_init.text

            r_tools = client.post(
                "/mcp",
                json=list_rpc,
                headers={
                    "Accept": "application/json, text/event-stream",
                    "Authorization": f"Bearer {raw_key}",
                },
            )
            assert r_tools.status_code == 200, r_tools.text
            tool_names = {t["name"] for t in r_tools.json()["result"]["tools"]}
            assert "check_drug_pair_ddi" in tool_names
            assert "evaluate_regimen_mix" in tool_names

            # 4. Revoking the key immediately blocks /mcp again
            r_del = client.delete(f"/api/mcp/keys/{key_id}")
            assert r_del.status_code == 200
            r_revoked = client.post(
                "/mcp",
                json=init_rpc,
                headers={
                    "Accept": "application/json, text/event-stream",
                    "X-API-Key": raw_key,
                },
            )
            assert r_revoked.status_code == 401
