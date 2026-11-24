"""Unit tests for curated UniProt targets, substructure attribution, and PubMed novelty logic."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from ml.config import MORGAN_NBITS, TARGETS_PATH
from ml.explain import explain_molecule_substructures, render_attributed_2d_svg
from ml.novelty import (
    PubMedNoveltyChecker,
    build_pubmed_query,
    build_pubmed_web_url,
    classify_novelty_tier,
)

IMATINIB_SMILES = "Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1"


def test_curated_targets_json_integrity() -> None:
    targets = json.loads(TARGETS_PATH.read_text(encoding="utf-8"))
    assert len(targets) == 8

    in_domain = [t for t in targets if t["in_domain"]]
    out_of_domain = [t for t in targets if not t["in_domain"]]
    assert len(in_domain) >= 4
    assert len(out_of_domain) >= 2

    pos_controls = [t for t in targets if t.get("is_positive_control")]
    assert len(pos_controls) == 1
    assert pos_controls[0]["id"] == "human_abl1"

    valid_aa = set("ACDEFGHIKLMNPQRSTVWYBXZJUO")
    for t in targets:
        seq = t["sequence"]
        assert len(seq) == t["sequence_length"] and len(seq) >= 150
        assert set(seq).issubset(valid_aa)
        assert t["uniprot_id"]
        assert t["uniprot_url"].startswith("https://www.uniprot.org/uniprotkb/")
        assert t["domain_label"]
        assert t["pubmed_disease_terms"]


def test_substructure_attribution_and_dark_svg() -> None:
    rng = np.random.default_rng(42)
    weights = rng.uniform(0.0, 1.0, size=(MORGAN_NBITS,))
    svg, explanation = render_attributed_2d_svg(IMATINIB_SMILES, weights, top_k_bits=5)

    assert svg is not None and "<svg" in svg and "</svg>" in svg
    assert len(explanation["top_motifs"]) == 5
    assert len(explanation["highlight_atoms"]) >= 3
    for motif in explanation["top_motifs"]:
        assert 0 <= motif["bit_id"] < MORGAN_NBITS
        assert motif["importance_pct"] > 0.0
        assert motif["motif_label"]
        assert len(motif["atom_indices"]) >= 1

    # Deterministic repeat check
    exp2 = explain_molecule_substructures(IMATINIB_SMILES, weights, top_k_bits=5)
    assert exp2["highlight_atoms"] == explanation["highlight_atoms"]
    assert exp2["top_motifs"] == explanation["top_motifs"]


def test_pubmed_novelty_tiers_and_honest_offline_handling(tmp_path: Path) -> None:
    assert classify_novelty_tier(0, "ok")[0] == "unexplored"
    assert classify_novelty_tier(1, "ok")[0] == "emerging"
    assert classify_novelty_tier(5, "ok")[0] == "emerging"
    assert classify_novelty_tier(6, "ok")[0] == "supported"
    assert classify_novelty_tier(None, "unavailable")[0] == "unavailable"

    q = build_pubmed_query("Imatinib", '"malaria"[Title/Abstract]')
    url = build_pubmed_web_url(q)
    assert '"Imatinib"[Title/Abstract]' in q
    assert url.startswith("https://pubmed.ncbi.nlm.nih.gov/?term=")

    checker = PubMedNoveltyChecker(cache_path=tmp_path / "pm.json")
    offline_res = checker.check("Imatinib", '"malaria"[Title/Abstract]', offline=True)
    assert offline_res["status"] == "unavailable"
    assert offline_res["pubmed_count"] is None
    assert offline_res["novelty_tier"] == "unavailable"
    assert offline_res["pubmed_url"] == url
